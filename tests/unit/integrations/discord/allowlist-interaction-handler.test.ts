import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ButtonStyle, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { mockLogger } from '../../../setup';
import { AllowlistInteractionHandler, type AllowlistInteractionHandlerDeps } from '@/integrations/discord/allowlist-interaction-handler';
import { BLUE, BRIGHT_GREEN } from '@/integrations/discord/colors';
import type { AllowlistSagaExecutor, SagaStepResult, SagaInteractionResult } from '@/services';
import type { ContactBackend, Contact, ContactId } from '@/storage';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SAGA_ID           = 'saga-abc-123';
const PERSON_ID         = 'person-xyz' as ContactId;
const DISPLAY_NAME      = 'Alice Example';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeButtonInteraction(customId: string): {
    interaction: ButtonInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    followUp:    ReturnType<typeof mock>
    showModal:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const followUp    = mock(async () => ({}));
    const showModal   = mock(async () => ({}));
    const interaction = {
        customId,
        deferUpdate,
        editReply,
        followUp,
        showModal,
    } as unknown as ButtonInteraction;
    return { interaction, deferUpdate, editReply, followUp, showModal };
}

function makeModalInteraction(customId: string, displayName = DISPLAY_NAME): {
    interaction: ModalSubmitInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const interaction = {
        customId,
        fields: {
            getTextInputValue: mock((_fieldId: string) => displayName),
        },
        deferUpdate,
        editReply,
    } as unknown as ModalSubmitInteraction;
    return { interaction, deferUpdate, editReply };
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
    return {
        personId:    PERSON_ID,
        displayName: DISPLAY_NAME,
        identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }],
        createdAt:   '2025-01-01T00:00:00Z',
        updatedAt:   '2025-01-01T00:00:00Z',
        ...overrides,
    };
}

function makeDeps(overrides: {
    executor?:       Partial<AllowlistSagaExecutor>
    contactBackend?: Partial<ContactBackend>
} = {}): AllowlistInteractionHandlerDeps {
    const mockExecutor: AllowlistSagaExecutor = {
        start:        mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        submitName:   mock(async (): Promise<SagaInteractionResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        confirmMatch: mock(async (): Promise<SagaInteractionResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        skipMatch:    mock(async (): Promise<SagaInteractionResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        createNew:    mock(async (): Promise<SagaInteractionResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        ...overrides.executor,
    } as unknown as AllowlistSagaExecutor;

    const mockContactBackend: ContactBackend = {
        getContact: mock(async (): Promise<Contact | undefined> => makeContact()),
        ...overrides.contactBackend,
    } as unknown as ContactBackend;

    return { executor: mockExecutor, contactBackend: mockContactBackend };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AllowlistInteractionHandler', () => {
    let handler: AllowlistInteractionHandler;
    let deps: AllowlistInteractionHandlerDeps;

    beforeEach(() => {
        deps    = makeDeps();
        handler = new AllowlistInteractionHandler(deps);
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    // -----------------------------------------------------------------------
    // handleModalSubmit
    // -----------------------------------------------------------------------

    describe('handleModalSubmit', () => {
        test('ignores modal with no sagaId', async () => {
            const { interaction, deferUpdate } = makeModalInteraction('allowlist-name');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('defers update then calls submitName with provided display name', async () => {
            const { interaction, deferUpdate, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`, 'Bob Smith');
            deps.executor.submitName = mock(async (): Promise<SagaInteractionResult> => ({ action: 'completed', personId: PERSON_ID, displayName: 'Bob Smith' }));

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.executor.submitName).toHaveBeenCalledWith(SAGA_ID, 'Bob Smith');
            expect((interaction.fields.getTextInputValue as ReturnType<typeof mock>)).toHaveBeenCalledWith('display-name');
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('passes sagaId to submitName exactly as parsed, without trimming', async () => {
            const rawSagaId = `  ${SAGA_ID}  `;
            const { interaction } = makeModalInteraction(`allowlist-name:${rawSagaId}`, 'Bob Smith');

            await handler.handleModalSubmit(interaction);

            expect(deps.executor.submitName).toHaveBeenCalledWith(rawSagaId, 'Bob Smith');
        });

        test('renders completed embed when submitName returns completed', async () => {
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async (): Promise<SagaInteractionResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME }));

            await handler.handleModalSubmit(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string, color?: number } }[], components: unknown[] };
            expect(call.embeds[0].data.title).toContain('\u2713');
            // Kills llm mutant: BRIGHT_GREEN -> BLUE on the completed embed's color.
            expect(call.embeds[0].data.color).toBe(BRIGHT_GREEN);
            expect(call.components).toEqual([]);
        });

        test('renders review_match embed with buttons when submitName returns review_match', async () => {
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));

            await handler.handleModalSubmit(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[], components: { components: { data: { custom_id?: string } }[] }[] };
            expect(call.embeds[0].data.title).toBe('Is this the same person?');
            expect(call.components[0].components[0].data.custom_id).toContain('allowlist-yes:');
        });

        test.each(['not_found', 'wrong_state', 'invalid_step_data'] as const)('renders the no-longer-active embed when submitName is unavailable (%s)', async (reason) => {
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async (): Promise<SagaInteractionResult> => ({ action: 'unavailable', reason }));

            await handler.handleModalSubmit(interaction);

            expect(editReply).toHaveBeenCalledTimes(1);
            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string, description?: string, color?: number } }[], components: unknown[] };
            expect(call.embeds[0].data.title).toBe('This request is no longer active');
            expect(call.embeds[0].data.title).not.toBe('Allowlist Flow Cancelled');
            expect(call.embeds[0].data.description).toBe('It has expired or was already processed.');
            // Kills llm mutant: BLUE -> BRIGHT_GREEN on the unavailable embed's color.
            expect(call.embeds[0].data.color).toBe(BLUE);
            expect(call.components).toEqual([]);
        });

        test('re-renders the completed embed when a repeated click finds the saga already completed', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => ({
                action: 'unavailable', reason: 'already_completed', personId: PERSON_ID, displayName: 'Bob Jones',
            }));

            await handler.handleButton(interaction);

            expect(editReply).toHaveBeenCalledTimes(1);
            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string, description?: string, color?: number } }[], components: unknown[] };
            expect(call.embeds[0].data.title).toBe('Added to Allowlist ✓');
            expect(call.embeds[0].data.description).toBe('**Bob Jones** has been added to the allowlist.');
            expect(call.embeds[0].data.color).toBe(BRIGHT_GREEN);
            expect(call.components).toEqual([]);
        });

        test('logs error and renders error embed when submitName throws', async () => {
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async (): Promise<SagaInteractionResult> => {
                throw new Error('DynamoDB failure');
            });

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), sagaId: SAGA_ID, msg: 'Allowlist saga: failed to process name submission' }));
            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[], components: unknown[] };
            expect(call.embeds[0].data.title).toBe('Error');
        });
    });

    // -----------------------------------------------------------------------
    // handleButton
    // -----------------------------------------------------------------------

    describe('handleButton', () => {
        test('ignores button with no colon in customId', async () => {
            const { interaction, deferUpdate } = makeButtonInteraction('allowlist-yes');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('ignores button with empty sagaId', async () => {
            const { interaction, deferUpdate } = makeButtonInteraction('allowlist-yes:');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('allowlist-yes calls confirmMatch', async () => {
            const { interaction, deferUpdate, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.executor.confirmMatch).toHaveBeenCalledWith(SAGA_ID);
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('splits customId at the first colon, keeping later colons in sagaId', async () => {
            const { interaction, deferUpdate } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}:extra`);

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.executor.confirmMatch).toHaveBeenCalledWith(`${SAGA_ID}:extra`);
        });

        test('allowlist-next calls skipMatch', async () => {
            const { interaction, deferUpdate, editReply } = makeButtonInteraction(`allowlist-next:${SAGA_ID}`);

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.executor.skipMatch).toHaveBeenCalledWith(SAGA_ID);
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('allowlist-create calls createNew', async () => {
            const { interaction, deferUpdate, editReply } = makeButtonInteraction(`allowlist-create:${SAGA_ID}`);

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.executor.createNew).toHaveBeenCalledWith(SAGA_ID);
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('unknown prefix returns without calling executor or deferUpdate', async () => {
            const { interaction, deferUpdate, editReply } = makeButtonInteraction(`allowlist-unknown:${SAGA_ID}`);

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1); // deferred before switch
            expect(editReply).not.toHaveBeenCalled();
            expect(deps.executor.confirmMatch).not.toHaveBeenCalled();
            expect(deps.executor.skipMatch).not.toHaveBeenCalled();
            expect(deps.executor.createNew).not.toHaveBeenCalled();
        });

        test('logs error and renders error embed when executor throws', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => {
                throw new Error('saga failure');
            });

            await handler.handleButton(interaction);

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), sagaId: SAGA_ID, msg: 'Allowlist saga: failed to process button' }));
            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
            expect(call.embeds[0].data.title).toBe('Error');
        });

        describe('allowlist-startmodal', () => {
            test('shows modal without deferUpdate', async () => {
                const { interaction, deferUpdate, showModal } = makeButtonInteraction(`allowlist-startmodal:${SAGA_ID}`);

                await handler.handleButton(interaction);

                expect(deferUpdate).not.toHaveBeenCalled();
                expect(showModal).toHaveBeenCalledTimes(1);
            });

            test('shows modal with correct customId', async () => {
                const { interaction, showModal } = makeButtonInteraction(`allowlist-startmodal:${SAGA_ID}`);

                await handler.handleButton(interaction);

                const modalArg = showModal.mock.calls[0]?.[0] as {
                    toJSON: () => {
                        custom_id:  string
                        title:      string
                        components: { label?: string, component?: { custom_id?: string, style?: number, required?: boolean, placeholder?: string } }[]
                    }
                };
                const modal = modalArg.toJSON();
                expect(modal.custom_id).toBe(`allowlist-name:${SAGA_ID}`);
                expect(modal.title).toBe('Add to Allowlist');
                expect(modal.components).toHaveLength(1);
                expect(modal.components[0]).toEqual(expect.objectContaining({
                    label:     'Display name',
                    component: expect.objectContaining({
                        custom_id:   'display-name',
                        style:       1,
                        required:    true,
                        placeholder: 'Enter display name for new contact',
                    }),
                }));
            });
        });
    });

    // -----------------------------------------------------------------------
    // startFromApproval
    // -----------------------------------------------------------------------

    describe('startFromApproval', () => {
        test('sends ephemeral followUp and returns suffix when executor returns completed', async () => {
            const { interaction, followUp } = makeButtonInteraction('email-send-approveallowlist:42');
            deps.executor.start = mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME }));

            const { allowlistSuffix } = await handler.startFromApproval(interaction, 'email', 'alice@example.com', DISPLAY_NAME);

            expect(followUp).toHaveBeenCalledTimes(1);
            const followUpArgs = followUp.mock.calls[0]?.[0] as { content: string, ephemeral: boolean };
            expect(followUpArgs.content).toContain(DISPLAY_NAME);
            expect(followUpArgs.ephemeral).toBe(true);
            expect(allowlistSuffix).toContain(DISPLAY_NAME);
        });

        test('sends followUp with button when executor returns need_name', async () => {
            const { interaction, followUp } = makeButtonInteraction('email-send-approveallowlist:42');
            deps.executor.start = mock(async (): Promise<SagaStepResult> => ({ action: 'need_name', sagaId: SAGA_ID, hint: DISPLAY_NAME }));

            const { allowlistSuffix } = await handler.startFromApproval(interaction, 'email', 'alice@example.com', DISPLAY_NAME);

            expect(followUp).toHaveBeenCalledTimes(1);
            const followUpArgs = followUp.mock.calls[0]?.[0] as { content: string, components: { components: { data: { custom_id?: string, style?: ButtonStyle, label?: string } }[] }[], ephemeral: boolean };
            expect(followUpArgs.ephemeral).toBe(true);
            expect(followUpArgs.content).toBe('Add to allowlist:');
            const btn = followUpArgs.components[0]?.components[0];
            expect(btn.data.custom_id).toBe(`allowlist-startmodal:${SAGA_ID}`);
            expect(btn.data.style).toBe(ButtonStyle.Primary);
            // Kills llm mutant: 'Set up allowlist entry' -> 'Cancel' on the button's label.
            expect(btn.data.label).toBe('Set up allowlist entry');
            expect(allowlistSuffix).toBe('');
        });

        test('passes platform and identifierValue to executor.start', async () => {
            const { interaction } = makeButtonInteraction('bsky-send-approveallowlist:uuid');
            deps.executor.start   = mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME }));

            await handler.startFromApproval(interaction, 'bsky', 'alice.bsky.social', 'Alice');

            expect(deps.executor.start).toHaveBeenCalledWith('bsky', 'alice.bsky.social', 'Alice');
        });

        test('logs error and returns empty suffix when executor throws', async () => {
            const { interaction, followUp } = makeButtonInteraction('email-send-approveallowlist:42');
            deps.executor.start = mock(async (): Promise<SagaStepResult> => {
                throw new Error('start failure');
            });

            const { allowlistSuffix } = await handler.startFromApproval(interaction, 'email', 'alice@example.com');

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), platform: 'email', identifierValue: 'alice@example.com', msg: 'Allowlist saga: failed to start from approval' }));
            expect(followUp).not.toHaveBeenCalled();
            expect(allowlistSuffix).toBe('');
        });
    });

    // -----------------------------------------------------------------------
    // renderResult — review_match with contact variants
    // -----------------------------------------------------------------------

    describe('renderResult via handleButton (review_match)', () => {
        test('loads contact from backend and shows fields', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact({
                identifiers: [{ platform: 'email', value: 'alice@example.com' }],
                notes:       'Verified',
            }));

            await handler.handleButton(interaction);

            expect(deps.contactBackend.getContact).toHaveBeenCalledWith(PERSON_ID);
            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string, value: string, inline?: boolean }[] } }[] };
            const fields = call.embeds[0].data.fields ?? [];
            expect(fields.some(f => f.name === 'Name')).toBe(true);
            expect(fields.find(f => f.name === 'Name')?.inline).toBe(true);
            expect(fields.find(f => f.name === 'Person ID')).toEqual({ name: 'Person ID', value: PERSON_ID, inline: true });
            expect(fields.some(f => f.name === 'Identifiers')).toBe(true);
            expect(fields.find(f => f.name === 'Identifiers')?.inline).toBe(false);
            expect(fields.some(f => f.name === 'Notes')).toBe(true);
            expect(fields.find(f => f.name === 'Notes')?.inline).toBe(false);
        });

        test('uses the BLUE brand color for the review embed', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact());

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { color?: number } }[] };
            expect(call.embeds[0].data.color).toBe(BLUE);
        });

        test('formats identifiers as "platform: value" in the Identifiers field', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact({
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky',  value: '@alice.bsky.social' },
                ],
            }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string, value: string }[] } }[] };
            const fields = call.embeds[0].data.fields ?? [];
            const identifiersField = fields.find(f => f.name === 'Identifiers');
            expect(identifiersField).toBeDefined();
            expect(identifiersField?.value).toContain('email: alice@example.com');
            expect(identifiersField?.value).toContain('bsky: @alice.bsky.social');
            // Both entries separated by newline
            expect(identifiersField?.value).toContain('\n');
        });

        test('shows fallback description when contact not found', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch    = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async (): Promise<Contact | undefined> => undefined);

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { description?: string } }[] };
            expect(call.embeds[0].data.description).toContain(PERSON_ID);
        });

        test('shows contact without notes field when notes is absent', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch    = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact({ notes: undefined }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string }[] } }[] };
            const fields = call.embeds[0].data.fields ?? [];
            expect(fields.some(f => f.name === 'Notes')).toBe(false);
        });

        test('shows contact without identifiers field when identifiers is empty', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch    = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact({ identifiers: [] }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string }[] } }[] };
            const fields = call.embeds[0].data.fields ?? [];
            expect(fields.some(f => f.name === 'Identifiers')).toBe(false);
        });

        test('shows three action buttons with correct customIds', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { components: { components: { data: { custom_id?: string } }[] }[] };
            const buttons = call.components[0].components;
            expect(buttons).toHaveLength(3);
            const ids = buttons.map(b => b.data.custom_id);
            expect(ids[0]).toBe(`allowlist-yes:${SAGA_ID}`);
            expect(ids[1]).toBe(`allowlist-next:${SAGA_ID}`);
            expect(ids[2]).toBe(`allowlist-create:${SAGA_ID}`);
        });
    });

    describe('interaction completion contracts', () => {
        test('modal processing waits for deferUpdate before starting the saga', async () => {
            const deferGate = Promise.withResolvers<void>();
            const { interaction, deferUpdate } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deferUpdate.mockImplementation(() => deferGate.promise);
            const pending = handler.handleModalSubmit(interaction);
            try {
                await Bun.sleep(0);
                expect(deps.executor.submitName).not.toHaveBeenCalled();
            } finally {
                deferGate.resolve();
                await pending;
            }
        });

        test('successful modal processing waits until its completed response is edited', async () => {
            const editGate = Promise.withResolvers<void>();
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            editReply.mockImplementation(() => editGate.promise);
            let settled = false;
            const pending = handler.handleModalSubmit(interaction).then(() => {
                settled = true;
                return undefined;
            });
            try {
                await Bun.sleep(0);
                expect(editReply).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                editGate.resolve();
                await pending;
            }
        });

        test('failed modal processing waits until its error response is edited', async () => {
            const editGate = Promise.withResolvers<void>();
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async () => {
                throw new Error('submission failed');
            });
            editReply.mockImplementation(() => editGate.promise);
            let settled = false;
            const pending = handler.handleModalSubmit(interaction).then(() => {
                settled = true;
                return undefined;
            });
            try {
                await Bun.sleep(0);
                expect(editReply).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                editGate.resolve();
                await pending;
            }
        });

        test('start-modal buttons wait until Discord accepts the modal', async () => {
            const modalGate = Promise.withResolvers<void>();
            const { interaction, showModal } = makeButtonInteraction(`allowlist-startmodal:${SAGA_ID}`);
            showModal.mockImplementation(() => modalGate.promise);
            let settled = false;
            const pending = handler.handleButton(interaction).then(() => {
                settled = true;
                return undefined;
            });
            try {
                await Bun.sleep(0);
                expect(showModal).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                modalGate.resolve();
                await pending;
            }
        });

        test('ordinary buttons wait for deferUpdate before invoking the executor', async () => {
            const deferGate = Promise.withResolvers<void>();
            const { interaction, deferUpdate } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deferUpdate.mockImplementation(() => deferGate.promise);
            const pending = handler.handleButton(interaction);
            try {
                await Bun.sleep(0);
                expect(deps.executor.confirmMatch).not.toHaveBeenCalled();
            } finally {
                deferGate.resolve();
                await pending;
            }
        });

        test('successful button processing waits until its completed response is edited', async () => {
            const editGate = Promise.withResolvers<void>();
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            editReply.mockImplementation(() => editGate.promise);
            let settled = false;
            const pending = handler.handleButton(interaction).then(() => {
                settled = true;
                return undefined;
            });
            try {
                await Bun.sleep(0);
                expect(editReply).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                editGate.resolve();
                await pending;
            }
        });

        test('failed button processing waits until its error response is edited', async () => {
            const editGate = Promise.withResolvers<void>();
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async () => {
                throw new Error('confirmation failed');
            });
            editReply.mockImplementation(() => editGate.promise);
            let settled = false;
            const pending = handler.handleButton(interaction).then(() => {
                settled = true;
                return undefined;
            });
            try {
                await Bun.sleep(0);
                expect(editReply).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                editGate.resolve();
                await pending;
            }
        });

        test('completed approval starts wait for the confirmation follow-up', async () => {
            const followUpGate = Promise.withResolvers<void>();
            const { interaction, followUp } = makeButtonInteraction('email-send-approveallowlist:42');
            followUp.mockImplementation(() => followUpGate.promise);
            let settled = false;
            const pending = handler.startFromApproval(interaction, 'email', 'alice@example.com').then((result) => {
                settled = true;
                return result;
            });
            try {
                await Bun.sleep(0);
                expect(followUp).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                followUpGate.resolve();
                expect(await pending).toEqual({ allowlistSuffix: ` + ${DISPLAY_NAME} allowlisted` });
            }
        });

        test('approval starts needing a name wait for the setup follow-up', async () => {
            const followUpGate = Promise.withResolvers<void>();
            const { interaction, followUp } = makeButtonInteraction('email-send-approveallowlist:42');
            deps.executor.start = mock(async (): Promise<SagaStepResult> => ({ action: 'need_name', sagaId: SAGA_ID }));
            followUp.mockImplementation(() => followUpGate.promise);
            let settled = false;
            const pending = handler.startFromApproval(interaction, 'email', 'alice@example.com').then((result) => {
                settled = true;
                return result;
            });
            try {
                await Bun.sleep(0);
                expect(followUp).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                followUpGate.resolve();
                expect(await pending).toEqual({ allowlistSuffix: '' });
            }
        });

        test('review results wait for their response edits', async () => {
            const editGate = Promise.withResolvers<void>();
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            editReply.mockImplementation(() => editGate.promise);
            let settled = false;
            const pending = handler.handleButton(interaction).then(() => {
                settled = true;
                return undefined;
            });
            try {
                await Bun.sleep(0);
                expect(editReply).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                editGate.resolve();
                await pending;
            }
        });

        test.each([
            ['no-longer-active', { action: 'unavailable', reason: 'not_found' }],
            ['already-completed', { action: 'unavailable', reason: 'already_completed', personId: PERSON_ID, displayName: DISPLAY_NAME }],
        ] as [string, SagaInteractionResult][])('unavailable %s results wait for their response edits', async (_label, unavailable) => {
            const editGate = Promise.withResolvers<void>();
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => unavailable);
            editReply.mockImplementation(() => editGate.promise);
            let settled = false;
            const pending = handler.handleButton(interaction).then(() => {
                settled = true;
                return undefined;
            });
            try {
                await Bun.sleep(0);
                expect(editReply).toHaveBeenCalledTimes(1);
                expect(settled).toBe(false);
            } finally {
                editGate.resolve();
                await pending;
            }
        });

        test('contact review presents the display name under the Name field', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaInteractionResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string, value: string, inline?: boolean }[] } }[] };
            expect(call.embeds[0].data.fields?.find(field => field.name === 'Name')).toEqual({
                name:   'Name',
                value:  DISPLAY_NAME,
                inline: true,
            });
        });
    });
});
