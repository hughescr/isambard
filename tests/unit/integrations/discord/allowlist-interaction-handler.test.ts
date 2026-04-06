/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Test assertions use optional chaining on cast values for defensive access */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ButtonStyle, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { mockLogger } from '../../../setup';
import { AllowlistInteractionHandler, type AllowlistInteractionHandlerDeps } from '@/integrations/discord/allowlist-interaction-handler';
import type { AllowlistSagaExecutor, SagaStepResult } from '@/services';
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
        submitName:   mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        confirmMatch: mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        skipMatch:    mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        createNew:    mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME })),
        cancel:       mock(async (): Promise<SagaStepResult> => ({ action: 'cancelled' })),
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
            deps.executor.submitName = mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: 'Bob Smith' }));

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(deps.executor.submitName).toHaveBeenCalledWith(SAGA_ID, 'Bob Smith');
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('renders completed embed when submitName returns completed', async () => {
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async (): Promise<SagaStepResult> => ({ action: 'completed', personId: PERSON_ID, displayName: DISPLAY_NAME }));

            await handler.handleModalSubmit(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string, color?: number } }[], components: unknown[] };
            expect(call?.embeds[0]?.data.title).toContain('\u2713');
            expect(call?.components).toEqual([]);
        });

        test('renders review_match embed with buttons when submitName returns review_match', async () => {
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async (): Promise<SagaStepResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));

            await handler.handleModalSubmit(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[], components: { components: { data: { custom_id?: string } }[] }[] };
            expect(call?.embeds[0]?.data.title).toBe('Is this the same person?');
            expect(call?.components[0]?.components[0]?.data.custom_id).toContain('allowlist-yes:');
        });

        test('renders cancelled embed when submitName returns cancelled', async () => {
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async (): Promise<SagaStepResult> => ({ action: 'cancelled' }));

            await handler.handleModalSubmit(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[], components: unknown[] };
            expect(call?.embeds[0]?.data.title).toBe('Allowlist Flow Cancelled');
            expect(call?.components).toEqual([]);
        });

        test('logs error and renders error embed when submitName throws', async () => {
            const { interaction, editReply } = makeModalInteraction(`allowlist-name:${SAGA_ID}`);
            deps.executor.submitName = mock(async (): Promise<SagaStepResult> => {
                throw new Error('DynamoDB failure');
            });

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[], components: unknown[] };
            expect(call?.embeds[0]?.data.title).toBe('Error');
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
            deps.executor.confirmMatch = mock(async (): Promise<SagaStepResult> => {
                throw new Error('saga failure');
            });

            await handler.handleButton(interaction);

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
            expect(call?.embeds[0]?.data.title).toBe('Error');
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

                const modalArg = showModal.mock.calls[0]?.[0] as { data: { custom_id?: string, title?: string } };
                expect(modalArg?.data.custom_id).toBe(`allowlist-name:${SAGA_ID}`);
                expect(modalArg?.data.title).toBe('Add to Allowlist');
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
            const followUpArgs = followUp.mock.calls[0]?.[0] as { components: { components: { data: { custom_id?: string, style?: ButtonStyle } }[] }[], ephemeral: boolean };
            expect(followUpArgs.ephemeral).toBe(true);
            const btn = followUpArgs.components[0]?.components[0];
            expect(btn?.data.custom_id).toBe(`allowlist-startmodal:${SAGA_ID}`);
            expect(btn?.data.style).toBe(ButtonStyle.Primary);
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
            deps.executor.confirmMatch = mock(async (): Promise<SagaStepResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact({
                identifiers: [{ platform: 'email', value: 'alice@example.com' }],
                notes:       'Verified',
            }));

            await handler.handleButton(interaction);

            expect(deps.contactBackend.getContact).toHaveBeenCalledWith(PERSON_ID);
            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string, value: string }[] } }[] };
            const fields = call?.embeds[0]?.data.fields ?? [];
            expect(fields.some(f => f.name === 'Name')).toBe(true);
            expect(fields.some(f => f.name === 'Identifiers')).toBe(true);
            expect(fields.some(f => f.name === 'Notes')).toBe(true);
        });

        test('formats identifiers as "platform: value" in the Identifiers field', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaStepResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact({
                identifiers: [
                    { platform: 'email', value: 'alice@example.com' },
                    { platform: 'bsky',  value: '@alice.bsky.social' },
                ],
            }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string, value: string }[] } }[] };
            const fields = call?.embeds[0]?.data.fields ?? [];
            const identifiersField = fields.find(f => f.name === 'Identifiers');
            expect(identifiersField).toBeDefined();
            expect(identifiersField?.value).toContain('email: alice@example.com');
            expect(identifiersField?.value).toContain('bsky: @alice.bsky.social');
            // Both entries separated by newline
            expect(identifiersField?.value).toContain('\n');
        });

        test('shows fallback description when contact not found', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch    = mock(async (): Promise<SagaStepResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async (): Promise<Contact | undefined> => undefined);

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { description?: string } }[] };
            expect(call?.embeds[0]?.data.description).toContain(PERSON_ID);
        });

        test('shows contact without notes field when notes is absent', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch    = mock(async (): Promise<SagaStepResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact({ notes: undefined }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string }[] } }[] };
            const fields = call?.embeds[0]?.data.fields ?? [];
            expect(fields.some(f => f.name === 'Notes')).toBe(false);
        });

        test('shows contact without identifiers field when identifiers is empty', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch    = mock(async (): Promise<SagaStepResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));
            deps.contactBackend.getContact = mock(async () => makeContact({ identifiers: [] }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { embeds: { data: { fields?: { name: string }[] } }[] };
            const fields = call?.embeds[0]?.data.fields ?? [];
            expect(fields.some(f => f.name === 'Identifiers')).toBe(false);
        });

        test('shows three action buttons with correct customIds', async () => {
            const { interaction, editReply } = makeButtonInteraction(`allowlist-yes:${SAGA_ID}`);
            deps.executor.confirmMatch = mock(async (): Promise<SagaStepResult> => ({ action: 'review_match', sagaId: SAGA_ID, matchPersonId: PERSON_ID }));

            await handler.handleButton(interaction);

            const call = editReply.mock.calls[0]?.[0] as { components: { components: { data: { custom_id?: string } }[] }[] };
            const buttons = call?.components[0]?.components ?? [];
            expect(buttons).toHaveLength(3);
            const ids = buttons.map(b => b.data.custom_id);
            expect(ids[0]).toBe(`allowlist-yes:${SAGA_ID}`);
            expect(ids[1]).toBe(`allowlist-next:${SAGA_ID}`);
            expect(ids[2]).toBe(`allowlist-create:${SAGA_ID}`);
        });
    });
});
