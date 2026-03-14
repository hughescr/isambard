/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Test assertions use optional chaining on cast values for defensive access */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import type { BskyAllowlist } from '../../../../src/integrations/bsky/allowlist';
import type { BlueskyClient } from '../../../../src/integrations/bsky/client';
import { BskyOutboundApprovalHandler, type BskyOutboundApprovalHandlerDeps } from '../../../../src/integrations/bsky/outbound-approval-handler';
import { mockLogger } from '../../../setup';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_UUID   = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const PARENT_URI  = 'at://did:plc:test/app.bsky.feed.post/parent123';
const PARENT_CID  = 'bafyreparentcid';
const ROOT_URI    = 'at://did:plc:test/app.bsky.feed.post/root456';
const ROOT_CID    = 'bafyrerootcid';
const TEST_HANDLE = 'someone.bsky.social';
const TEST_DID    = 'did:plc:someoneabc';
const POST_TEXT   = 'Hello @someone.bsky.social!';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeEmbedFields(opts: {
    text?:         string
    targetHandle?: string
    parentUri?:    string
    parentCid?:    string
    rootUri?:      string
    rootCid?:      string
} = {}): { name: string, value: string, inline: boolean }[] {
    const fields: { name: string, value: string, inline: boolean }[] = [
        { name: 'Replying to', value: opts.targetHandle ?? TEST_HANDLE, inline: true },
        { name: 'Parent URI',  value: opts.parentUri ?? PARENT_URI,     inline: true },
        { name: 'Parent CID',  value: opts.parentCid ?? PARENT_CID,     inline: true },
    ];
    if(opts.rootUri !== undefined) {
        fields.push(
            { name: 'Root URI', value: opts.rootUri,             inline: true },
            { name: 'Root CID', value: opts.rootCid ?? ROOT_CID, inline: true }
        );
    }
    return fields;
}

function makeButtonInteraction(customId: string, embedOpts: {
    text?:         string
    targetHandle?: string
    parentUri?:    string
    parentCid?:    string
    rootUri?:      string
    rootCid?:      string
} = {}): {
    interaction: ButtonInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    showModal:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const showModal   = mock(async () => ({}));
    const interaction = {
        customId,
        message: {
            embeds: [{
                description: embedOpts.text ?? POST_TEXT,
                fields:      makeEmbedFields(embedOpts),
            }],
        },
        deferUpdate,
        editReply,
        showModal,
    } as unknown as ButtonInteraction;
    return { interaction, deferUpdate, editReply, showModal };
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
        fields: {
            getTextInputValue: mock((_fieldId: string) => reason),
        },
        deferUpdate,
        editReply,
    } as unknown as ModalSubmitInteraction;
    return { interaction, deferUpdate, editReply };
}

function makeDeps(overrides: Partial<BskyOutboundApprovalHandlerDeps> = {}): BskyOutboundApprovalHandlerDeps {
    const mockClient: BlueskyClient = {
        replyToPost: mock(async (): Promise<{ uri: string, cid: string }> => ({ uri: 'at://result/uri', cid: 'bafyreresult' })),
        getProfile:  mock(async () => ({ did: TEST_DID, handle: TEST_HANDLE })),
    } as unknown as BlueskyClient;

    const mockAllowlist: BskyAllowlist = {
        addEntry:  mock(async () => { /* intentionally empty */ }),
        isAllowed: mock(() => false),
    } as unknown as BskyAllowlist;

    return {
        client:    mockClient,
        allowlist: mockAllowlist,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BskyOutboundApprovalHandler', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
    });

    describe('handleButton()', () => {
        test('should return early for unknown prefix', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeButtonInteraction('email-other:42');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(deps.client.replyToPost).not.toHaveBeenCalled();
        });

        test('should return early when uuid is missing', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            // customId with no colon means parts[1] is undefined
            const { interaction, deferUpdate } = makeButtonInteraction('bsky-send-approve');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        describe('approve (bsky-send-approve)', () => {
            test('should deferUpdate, call replyToPost, show success embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, deferUpdate, editReply } = makeButtonInteraction(`bsky-send-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deferUpdate).toHaveBeenCalledTimes(1);
                expect(deps.client.replyToPost).toHaveBeenCalledTimes(1);
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should call replyToPost with text and parent URI/CID from embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction(`bsky-send-approve:${TEST_UUID}`, {
                    text:      POST_TEXT,
                    parentUri: PARENT_URI,
                    parentCid: PARENT_CID,
                });

                await handler.handleButton(interaction);

                expect(deps.client.replyToPost).toHaveBeenCalledWith(
                    POST_TEXT,
                    PARENT_URI,
                    PARENT_CID,
                    undefined,
                    undefined
                );
            });

            test('should pass rootUri/rootCid to replyToPost when present in embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction(`bsky-send-approve:${TEST_UUID}`, {
                    rootUri: ROOT_URI,
                    rootCid: ROOT_CID,
                });

                await handler.handleButton(interaction);

                expect(deps.client.replyToPost).toHaveBeenCalledWith(
                    POST_TEXT,
                    PARENT_URI,
                    PARENT_CID,
                    ROOT_URI,
                    ROOT_CID
                );
            });

            test('should NOT add to allowlist on plain approve', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction(`bsky-send-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
                expect(deps.client.getProfile).not.toHaveBeenCalled();
            });

            test('should clear embed buttons in success editReply', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction(`bsky-send-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: unknown[], components: unknown[] };
                expect(replyArg.embeds).toHaveLength(1);
                expect(replyArg.components).toHaveLength(0);
            });

            test('should throw if parentUri is missing from embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                // Embed with no fields at all
                const interaction = {
                    customId: `bsky-send-approve:${TEST_UUID}`,
                    message:  {
                        embeds: [{
                            description: POST_TEXT,
                            fields:      [],
                        }],
                    },
                    deferUpdate: mock(async () => ({})),
                    editReply:   mock(async () => ({})),
                    showModal:   mock(async () => ({})),
                } as unknown as ButtonInteraction;

                await handler.handleButton(interaction);

                // Error was caught and editReply called with error message
                expect(mockLogger.error).toHaveBeenCalled();
            });
        });

        describe('approve+allowlist (bsky-send-approveallowlist)', () => {
            test('should deferUpdate, call replyToPost, add to allowlist, show success embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, deferUpdate, editReply } = makeButtonInteraction(`bsky-send-approveallowlist:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deferUpdate).toHaveBeenCalledTimes(1);
                expect(deps.client.replyToPost).toHaveBeenCalledTimes(1);
                expect(deps.client.getProfile).toHaveBeenCalledWith(TEST_HANDLE);
                expect(deps.allowlist.addEntry).toHaveBeenCalledTimes(1);
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should call addEntry with handle, DID from getProfile, addedAt, and addedBy', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction(`bsky-send-approveallowlist:${TEST_UUID}`);

                await handler.handleButton(interaction);

                const addEntryArg = (deps.allowlist.addEntry as ReturnType<typeof mock>).mock.calls[0]?.[0];
                expect(addEntryArg.handle).toBe(TEST_HANDLE);
                expect(addEntryArg.did).toBe(TEST_DID);
                expect(addEntryArg.addedAt).toBeDefined();
                expect(addEntryArg.addedBy).toBe('outbound-approval');
            });

            test('should show "handle allowlisted" in embed title on allowlist success', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction(`bsky-send-approveallowlist:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deps.allowlist.addEntry).toHaveBeenCalledTimes(1);
                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
                expect(replyArg.embeds[0]?.data?.title).toContain('allowlisted');
            });

            test('should still complete post when allowlist addEntry fails, shows "allowlist failed" in embed title', async () => {
                const deps = makeDeps();
                (deps.allowlist.addEntry as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB error'));
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction(`bsky-send-approveallowlist:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deps.client.replyToPost).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn).toHaveBeenCalled();
                expect(editReply).toHaveBeenCalledTimes(1);
                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
                expect(replyArg.embeds[0]?.data?.title).toContain('allowlist failed');
            });

            test('should still complete post when getProfile fails', async () => {
                const deps = makeDeps();
                (deps.client.getProfile as ReturnType<typeof mock>).mockRejectedValue(new Error('profile fetch failed'));
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction(`bsky-send-approveallowlist:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deps.client.replyToPost).toHaveBeenCalledTimes(1);
                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
                expect(mockLogger.warn).toHaveBeenCalled();
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should call replyToPost with text and parent URI/CID from embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction(`bsky-send-approveallowlist:${TEST_UUID}`, {
                    text:      POST_TEXT,
                    parentUri: PARENT_URI,
                    parentCid: PARENT_CID,
                });

                await handler.handleButton(interaction);

                expect(deps.client.replyToPost).toHaveBeenCalledWith(
                    POST_TEXT,
                    PARENT_URI,
                    PARENT_CID,
                    undefined,
                    undefined
                );
            });

            test('should pass rootUri/rootCid to replyToPost when present in embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeButtonInteraction(`bsky-send-approveallowlist:${TEST_UUID}`, {
                    rootUri: ROOT_URI,
                    rootCid: ROOT_CID,
                });

                await handler.handleButton(interaction);

                expect(deps.client.replyToPost).toHaveBeenCalledWith(
                    POST_TEXT,
                    PARENT_URI,
                    PARENT_CID,
                    ROOT_URI,
                    ROOT_CID
                );
            });

            test('should NOT call getProfile when targetHandle is missing from embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                // Embed without Replying to field
                const interaction = {
                    customId: `bsky-send-approveallowlist:${TEST_UUID}`,
                    message:  {
                        embeds: [{
                            description: POST_TEXT,
                            fields:      [
                                { name: 'Parent URI', value: PARENT_URI, inline: true },
                                { name: 'Parent CID', value: PARENT_CID, inline: true },
                            ],
                        }],
                    },
                    deferUpdate: mock(async () => ({})),
                    editReply:   mock(async () => ({})),
                    showModal:   mock(async () => ({})),
                } as unknown as ButtonInteraction;

                await handler.handleButton(interaction);

                expect(deps.client.replyToPost).toHaveBeenCalledTimes(1);
                expect(deps.client.getProfile).not.toHaveBeenCalled();
                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
            });

            test('should clear embed buttons after approve+allowlist', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction(`bsky-send-approveallowlist:${TEST_UUID}`);

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: unknown[], components: unknown[] };
                expect(replyArg.embeds).toHaveLength(1);
                expect(replyArg.components).toHaveLength(0);
            });
        });

        describe('reject (bsky-send-reject)', () => {
            test('should show a modal for rejection reason without deferUpdate', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, deferUpdate, showModal } = makeButtonInteraction(`bsky-send-reject:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deferUpdate).not.toHaveBeenCalled();
                expect(showModal).toHaveBeenCalledTimes(1);
                expect(deps.client.replyToPost).not.toHaveBeenCalled();
            });

            test('should show modal with customId containing original uuid', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, showModal } = makeButtonInteraction(`bsky-send-reject:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(showModal).toHaveBeenCalledTimes(1);
                const modalArg = showModal.mock.calls[0]?.[0] as { data: { custom_id: string } };
                expect(modalArg.data?.custom_id).toContain(TEST_UUID);
            });

            test('should set rejection reason text input as not required', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, showModal } = makeButtonInteraction(`bsky-send-reject:${TEST_UUID}`);

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
            test('should call editReply with error message when replyToPost fails', async () => {
                const deps = makeDeps();
                (deps.client.replyToPost as ReturnType<typeof mock>).mockRejectedValue(new Error('Bluesky API error'));
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction(`bsky-send-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(editReply).toHaveBeenCalledTimes(1);
                expect(mockLogger.error).toHaveBeenCalled();
            });

            test('should call editReply with embeds and components cleared on error', async () => {
                const deps = makeDeps();
                (deps.client.replyToPost as ReturnType<typeof mock>).mockRejectedValue(new Error('API failed'));
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeButtonInteraction(`bsky-send-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                const editReplyArg = editReply.mock.calls[0]?.[0];
                expect(editReplyArg.embeds).toEqual([]);
                expect(editReplyArg.components).toEqual([]);
                expect(editReplyArg.content).toContain('error occurred');
            });

            test('should log error if editReply fails after error', async () => {
                const deps = makeDeps();
                (deps.client.replyToPost as ReturnType<typeof mock>).mockRejectedValue(new Error('API failed'));
                const { interaction, editReply } = makeButtonInteraction(`bsky-send-approve:${TEST_UUID}`);
                editReply.mockRejectedValue(new Error('Discord error'));
                const handler = new BskyOutboundApprovalHandler(deps);

                await handler.handleButton(interaction);

                expect(mockLogger.error).toHaveBeenCalledTimes(2);
            });

            test('should NOT call editReply when reject path (showModal) throws', async () => {
                // Reject path does not defer, so editReply must not be called on error
                const deps = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply, showModal } = makeButtonInteraction(`bsky-send-reject:${TEST_UUID}`);
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
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeModalInteraction('email-other-modal:42');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should return early when uuid is missing', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeModalInteraction('bsky-send-reject-reason');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should deferUpdate and update embed with rejection reason', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate, editReply } = makeModalInteraction(`bsky-send-reject-reason:${TEST_UUID}`, 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('should NOT call replyToPost after rejection', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction(`bsky-send-reject-reason:${TEST_UUID}`, 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deps.client.replyToPost).not.toHaveBeenCalled();
        });

        test('should show "Rejected: {reason}" embed after modal submit', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, editReply } = makeModalInteraction(`bsky-send-reject-reason:${TEST_UUID}`, 'Off topic');

            await handler.handleModalSubmit(interaction);

            const replyArg = editReply.mock.calls[0]?.[0] as { embeds: unknown[], components: unknown[] };
            expect(replyArg.embeds).toHaveLength(1);
            expect(replyArg.components).toHaveLength(0);
        });

        test('should use "No reason given" when reason is empty', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, editReply } = makeModalInteraction(`bsky-send-reject-reason:${TEST_UUID}`, '');

            expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title: string } }[], components: unknown[] };
            // The embed title should contain 'No reason given'
            expect(JSON.stringify(replyArg.embeds)).toContain('No reason given');
        });

        test('should log error if modal processing fails', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction(`bsky-send-reject-reason:${TEST_UUID}`);
            // Force an error by making getTextInputValue throw
            (interaction.fields.getTextInputValue as ReturnType<typeof mock>).mockImplementation(() => {
                throw new Error('field error');
            });

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.error).toHaveBeenCalled();
        });
    });
});
