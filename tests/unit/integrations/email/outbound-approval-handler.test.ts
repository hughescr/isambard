/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import { mockLogger } from '../../../setup';
import { OutboundApprovalHandler } from '../../../../src/integrations/email/outbound-approval-handler';
import type { OutboundApprovalHandlerDeps } from '../../../../src/integrations/email/outbound-approval-handler';
import type { EmailAllowlist } from '../../../../src/integrations/email/allowlist';
import type { WildDuckClient } from '../../../../src/integrations/email/wildduck-client';
import type { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';

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

function makeModalInteraction(customId: string, reason = 'Not appropriate'): {
    interaction: ModalSubmitInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const interaction = {
        customId,
        user:   { id: ADMIN_USER_ID },
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

    const mockAllowlist: EmailAllowlist = {
        addEntry:  mock(async () => { /* intentionally empty */ }),
        isAllowed: mock(_.constant(false)),
    } as unknown as EmailAllowlist;

    return {
        wildDuckClient: mockWildDuck,
        allowlist:      mockAllowlist,
        ...overrides,
    };
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

    describe('handleButton()', () => {
        test('should return early for unknown prefix', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeButtonInteraction('email-other:42');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
        });

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeButtonInteraction('email-send-approve:notanumber');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        describe('approve (email-send-approve)', () => {
            test('should deferUpdate, call submitMessage, show success embed', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, deferUpdate, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(deferUpdate).toHaveBeenCalledTimes(1);
                expect(deps.wildDuckClient.submitMessage).toHaveBeenCalledWith('Drafts', 42);
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should call submitMessage with correct folder and UID', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approve:99');

                await handler.handleButton(interaction);

                expect(deps.wildDuckClient.submitMessage).toHaveBeenCalledWith('Drafts', 99);
            });

            test('should NOT add recipient to allowlist on plain approve', async () => {
                const deps    = makeDeps();
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
            });

            test('should show "Sent ✓" embed in green after successful approve', async () => {
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
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call args
                const replyArg = editReply.mock.calls[0]?.[0];
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
                expect(replyArg.components).toBeDefined();
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
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

                // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();
                // Falls back to simple approve — submit is called
                expect(deps.wildDuckClient.submitMessage).toHaveBeenCalledTimes(1);
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should fall back to simple approve when getMessage throws', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.getMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('fetch failed'));
                const handler = new OutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction('email-send-approveallowlist:42');

                // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();
                // Falls back to simple approve
                expect(deps.wildDuckClient.submitMessage).toHaveBeenCalledTimes(1);
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

                // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
                await expect(handler.handleButton(interaction)).resolves.toBeUndefined();
                // Falls back to simple approve
                expect(deps.wildDuckClient.submitMessage).toHaveBeenCalledTimes(1);
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

                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call args
                const replyArg = editReply.mock.calls[0]?.[0];
                // The select menu component should have deduplicated options
                const menuOptions = (replyArg as { components: { components: { options: { data: { value: string } }[] }[] }[] })
                    .components?.[0]?.components?.[0]?.options;
                expect(menuOptions).toBeDefined();
                // 'duplicate@example.com' should appear only once; 'other@example.com' once → total 2
                expect(menuOptions).toHaveLength(2);
                const values = _.map(menuOptions, 'data.value');
                expect(values).toContain('duplicate@example.com');
                expect(values).toContain('other@example.com');
                // No duplicates
                expect(new Set(values).size).toBe(2);
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
                expect(modalArg.data?.custom_id).toContain('99');
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
                    components: { component: { required?: boolean } }[]
                } };
                const modalJson = modalArg.toJSON();
                // The text input should be optional (not required)
                const textInput = modalJson.components?.[0]?.component;
                expect(textInput?.required).toBe(false);
            });
        });

        describe('error handling', () => {
            test('should call editReply with error message when submitMessage fails', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.submitMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('WildDuck submit failed'));
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                expect(editReply).toHaveBeenCalledTimes(1);
                expect(mockLogger.error).toHaveBeenCalled();
            });

            test('should call editReply with embeds and components cleared on error', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.submitMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('WildDuck failed'));
                const handler = new OutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');

                await handler.handleButton(interaction);

                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call args
                const editReplyArg = editReply.mock.calls[0]?.[0];
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
                expect(editReplyArg.embeds).toEqual([]);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
                expect(editReplyArg.components).toEqual([]);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
                expect(editReplyArg.content).toContain('error occurred');
            });

            test('should log error if editReply fails after error', async () => {
                const deps = makeDeps();
                (deps.wildDuckClient.submitMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('WildDuck failed'));
                const { interaction, editReply } = makeButtonInteraction('email-send-approve:42');
                editReply.mockRejectedValue(new Error('Discord error'));
                const handler = new OutboundApprovalHandler(deps);

                await handler.handleButton(interaction);

                expect(mockLogger.error).toHaveBeenCalledTimes(2);
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

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeModalInteraction('email-send-reject-reason:notanumber');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should deferUpdate, call updateMessageMetadata with reason, set flag via wildDuck, update embed', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.wildDuckClient.updateMessageMetadata).toHaveBeenCalledTimes(1);
            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect(updateArgs?.[0]).toBe('Drafts');
            expect(updateArgs?.[1]).toBe(42);
            expect((updateArgs?.[2] as Record<string, unknown>)?.reason).toBe('Not appropriate');
            expect(deps.wildDuckClient.updateMessageFlags).toHaveBeenCalledWith('Drafts', 42, { addFlags: ['SendRejectedByAdmin'] });
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('should include rejectedAt timestamp in updateMessageMetadata call', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs?.[2] as Record<string, unknown>)?.rejectedAt).toBeDefined();
        });

        test('should NOT include to or subject in updateMessageMetadata call (stored as message fields)', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs?.[2] as Record<string, unknown>)?.to).toBeUndefined();
            expect((updateArgs?.[2] as Record<string, unknown>)?.subject).toBeUndefined();
        });

        test('should NOT call getMessage during rejection (no metadata preservation needed)', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Bad content');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.getMessage).not.toHaveBeenCalled();
        });

        test('should show "Rejected: {reason}" in embed after reject', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeModalInteraction('email-send-reject-reason:42', 'Off topic');

            await handler.handleModalSubmit(interaction);

            const replyArg = editReply.mock.calls[0]?.[0] as {
                embeds:     unknown[]
                components: unknown[]
            };
            expect(replyArg.embeds).toHaveLength(1);
            expect(replyArg.components).toHaveLength(0);
        });

        test('should use "No reason given" when reason is empty', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', '');

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            const updateArgs = (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mock.calls[0];
            expect((updateArgs?.[2] as Record<string, unknown>)?.reason).toBe('No reason given');
        });

        test('should set flag via wildDuckClient.updateMessageFlags after rejection', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.updateMessageFlags).toHaveBeenCalledWith('Drafts', 42, { addFlags: ['SendRejectedByAdmin'] });
        });

        test('should NOT submit message after rejection (draft stays in Drafts)', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42', 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
        });

        test('should log error if updateMessageMetadata fails', async () => {
            const deps = makeDeps();
            (deps.wildDuckClient.updateMessageMetadata as ReturnType<typeof mock>).mockRejectedValue(new Error('WildDuck error'));
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction('email-send-reject-reason:42');

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.error).toHaveBeenCalled();
        });
    });

    describe('handleSelectMenu()', () => {
        test('should return early for unknown prefix', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-other-select:42', []);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.wildDuckClient.submitMessage).not.toHaveBeenCalled();
        });

        test('should return early for invalid UID', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeSelectMenuInteraction('email-allowlist-select:notanumber', []);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should deferUpdate, submit draft, update embed to Sent when recipients selected', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, deferUpdate, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', ['addr@example.com']);

            await handler.handleSelectMenu(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.wildDuckClient.submitMessage).toHaveBeenCalledWith('Drafts', 42);
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('should add each selected recipient to allowlist', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', ['a@example.com', 'b@example.com']);

            await handler.handleSelectMenu(interaction);

            expect(deps.allowlist.addEntry).toHaveBeenCalledTimes(2);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call args
            const firstArg = (deps.allowlist.addEntry as ReturnType<typeof mock>).mock.calls[0]?.[0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
            expect(firstArg.email).toBe('a@example.com');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call args
            const secondArg = (deps.allowlist.addEntry as ReturnType<typeof mock>).mock.calls[1]?.[0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
            expect(secondArg.email).toBe('b@example.com');
        });

        test('should submit draft without adding to allowlist when no recipients selected', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await handler.handleSelectMenu(interaction);

            expect(deps.wildDuckClient.submitMessage).toHaveBeenCalledTimes(1);
            expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
        });

        test('should log warning but still succeed when allowlist.addEntry fails for one recipient', async () => {
            const deps = makeDeps();
            (deps.allowlist.addEntry as ReturnType<typeof mock>).mockRejectedValue(new Error('allowlist write failed'));
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', ['addr@example.com']);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalled();
            // Edit reply still called to show success
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('should show error editReply when submitMessage throws', async () => {
            const deps = makeDeps();
            (deps.wildDuckClient.submitMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('submit failed'));
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();
            expect(mockLogger.error).toHaveBeenCalled();
            expect(editReply).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call args
            const replyArg = editReply.mock.calls[0]?.[0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
            expect(replyArg.content).toContain('error occurred');
        });

        test('should log error when editReply fails after submitMessage error', async () => {
            const deps = makeDeps();
            (deps.wildDuckClient.submitMessage as ReturnType<typeof mock>).mockRejectedValue(new Error('submit failed'));
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);
            editReply.mockRejectedValue(new Error('Discord error'));

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(handler.handleSelectMenu(interaction)).resolves.toBeUndefined();
            expect(mockLogger.error).toHaveBeenCalledTimes(2);
        });

        test('should show Sent embed with no components on success', async () => {
            const deps    = makeDeps();
            const handler = new OutboundApprovalHandler(deps);
            const { interaction, editReply } = makeSelectMenuInteraction('email-allowlist-select:42', []);

            await handler.handleSelectMenu(interaction);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- accessing mock call args
            const replyArg = editReply.mock.calls[0]?.[0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
            expect(replyArg.embeds).toHaveLength(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
            expect(replyArg.components).toHaveLength(0);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- accessing mock call args
            expect(replyArg.content).toBeNull();
        });
    });
});
