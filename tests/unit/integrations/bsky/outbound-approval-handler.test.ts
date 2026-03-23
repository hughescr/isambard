/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Test assertions use optional chaining on cast values for defensive access */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import type { BskyAllowlist } from '../../../../src/integrations/bsky/allowlist';
import type { BlueskyClient } from '../../../../src/integrations/bsky/client';
import { BskyOutboundApprovalHandler, type BskyOutboundApprovalHandlerDeps } from '../../../../src/integrations/bsky/outbound-approval-handler';
import { type BskyRejectionBackend } from '../../../../src/integrations/bsky/rejection-backend';
import { mockLogger } from '../../../setup';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_UUID        = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const PARENT_URI       = 'at://did:plc:test/app.bsky.feed.post/parent123';
const PARENT_CID       = 'bafyreparentcid';
const ROOT_URI         = 'at://did:plc:test/app.bsky.feed.post/root456';
const ROOT_CID         = 'bafyrerootcid';
const TEST_HANDLE      = 'someone.bsky.social';
const TEST_DID         = 'did:plc:someoneabc';
const POST_TEXT        = 'Hello @someone.bsky.social!';
const DM_TEXT          = 'Hey, want to collaborate?';
const DM_CONVO_ID      = 'convo-abc123';
const DM_HANDLE_ALICE  = 'alice.bsky.social';
const DM_HANDLE_BOB    = 'bob.bsky.social';
const DM_DID_ALICE     = 'did:plc:aliceabc';
const DM_DID_BOB       = 'did:plc:bobabc';

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

function makeModalInteraction(customId: string, reason = 'Not appropriate', embedData?: {
    description?: string
    fields?:      { name: string, value: string, inline?: boolean }[]
}): {
    interaction: ModalSubmitInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const interaction = {
        customId,
        message: embedData
            ? {
                embeds: [{
                    description: embedData.description ?? POST_TEXT,
                    fields:      embedData.fields ?? makeEmbedFields(),
                }],
            }
            : undefined,
        fields: {
            getTextInputValue: mock((_fieldId: string) => reason),
        },
        deferUpdate,
        editReply,
    } as unknown as ModalSubmitInteraction;
    return { interaction, deferUpdate, editReply };
}

function makeDMButtonInteraction(customId: string, opts: {
    text?:             string
    recipientHandles?: string[]
    convoId?:          string
} = {}): {
    interaction: ButtonInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    showModal:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const showModal   = mock(async () => ({}));
    const fields: { name: string, value: string, inline: boolean }[] = [
        { name: 'Recipients',       value: JSON.stringify(opts.recipientHandles ?? [DM_HANDLE_ALICE]), inline: false },
        { name: 'Conversation ID',  value: opts.convoId ?? DM_CONVO_ID,                               inline: true },
    ];
    const interaction = {
        customId,
        message: {
            embeds: [{
                description: opts.text ?? DM_TEXT,
                fields,
            }],
        },
        deferUpdate,
        editReply,
        showModal,
    } as unknown as ButtonInteraction;
    return { interaction, deferUpdate, editReply, showModal };
}

function makeDeps(overrides: Partial<BskyOutboundApprovalHandlerDeps> = {}): BskyOutboundApprovalHandlerDeps {
    const mockClient: BlueskyClient = {
        replyToPost:       mock(async (): Promise<{ uri: string, cid: string }> => ({ uri: 'at://result/uri', cid: 'bafyreresult' })),
        getProfile:        mock(async () => ({ did: TEST_DID, handle: TEST_HANDLE })),
        sendDirectMessage: mock(async (): Promise<{ id: string, rev: string, text: string, senderDid: string, sentAt: string }> => ({ id: 'msg-1', rev: 'rev-1', text: DM_TEXT, senderDid: 'did:plc:bot', sentAt: '2025-01-01T00:00:00Z' })),
    } as unknown as BlueskyClient;

    const mockAllowlist: BskyAllowlist = {
        addEntry:  mock(async () => { /* intentionally empty */ }),
        isAllowed: mock(() => false),
    } as unknown as BskyAllowlist;

    const mockRejectionBackend: BskyRejectionBackend = {
        recordRejection: mock(async () => { /* intentionally empty */ }),
        listRejections:  mock(async () => []),
        deleteRejection: mock(async () => { /* intentionally empty */ }),
        clearAll:        mock(async () => { /* intentionally empty */ }),
    } as unknown as BskyRejectionBackend;

    return {
        client:           mockClient,
        allowlist:        mockAllowlist,
        rejectionBackend: mockRejectionBackend,
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

        test('should return early when uuid is missing (no colon in customId)', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            // customId with no colon — parts.length < 2 guard fires
            const { interaction, deferUpdate } = makeButtonInteraction('bsky-send-approve');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should return early when uuid is empty string (colon with no value)', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            // customId with colon but empty uuid — parts[1] is '' which is falsy
            const { interaction, deferUpdate } = makeButtonInteraction('bsky-send-approve:');

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
                expect(modalArg.data?.custom_id).toBe(`bsky-send-reject-reason:${TEST_UUID}`);
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

            test('should show modal with title "Reject Bluesky Reply" for bsky-send-reject', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, showModal } = makeButtonInteraction(`bsky-send-reject:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(showModal).toHaveBeenCalledTimes(1);
                const modalArg = showModal.mock.calls[0]?.[0] as { data: { title: string } };
                expect(modalArg.data?.title).toBe('Reject Bluesky Reply');
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

        test('should return early when uuid is missing (no colon in customId)', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeModalInteraction('bsky-send-reject-reason');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should return early when uuid is empty string (colon with no value)', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            // colon present but uuid is empty — !uuid guard fires
            const { interaction, deferUpdate } = makeModalInteraction('bsky-send-reject-reason:');

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

        test('should show "Rejected" title with reason in description after modal submit', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, editReply } = makeModalInteraction(`bsky-send-reject-reason:${TEST_UUID}`, 'Off topic');

            await handler.handleModalSubmit(interaction);

            const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title: string, description: string } }[], components: unknown[] };
            expect(replyArg.embeds).toHaveLength(1);
            expect(replyArg.components).toHaveLength(0);
            expect(replyArg.embeds[0]?.data?.title).toBe('Rejected');
            expect(replyArg.embeds[0]?.data?.description).toBe('Off topic');
        });

        test('should use "No reason given" when reason is empty', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, editReply } = makeModalInteraction(`bsky-send-reject-reason:${TEST_UUID}`, '');

            expect(handler.handleModalSubmit(interaction)).resolves.toBeUndefined();

            const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title: string, description: string } }[], components: unknown[] };
            // The embed description should contain 'No reason given'
            expect(replyArg.embeds[0]?.data?.description).toContain('No reason given');
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

        test('should process bsky-dm-reject-reason modal and show rejection embed', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate, editReply } = makeModalInteraction(`bsky-dm-reject-reason:${TEST_UUID}`, 'Not appropriate');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const replyArg = editReply.mock.calls[0]?.[0] as { embeds: unknown[], components: unknown[] };
            expect(replyArg.embeds).toHaveLength(1);
            expect(replyArg.components).toHaveLength(0);
        });

        test('should return early for bsky-dm-reject-reason when uuid is missing (no colon)', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeModalInteraction('bsky-dm-reject-reason');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should return early for bsky-dm-reject-reason when uuid is empty string', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeModalInteraction('bsky-dm-reject-reason:');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        test('should persist reply rejection to backend', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction(
                `bsky-send-reject-reason:${TEST_UUID}`,
                'Too aggressive',
                { description: POST_TEXT, fields: makeEmbedFields() }
            );

            await handler.handleModalSubmit(interaction);

            expect(deps.rejectionBackend.recordRejection).toHaveBeenCalledTimes(1);
            const recorded = (deps.rejectionBackend.recordRejection as ReturnType<typeof mock>).mock.calls[0][0];
            expect(recorded.type).toBe('reply');
            expect(recorded.text).toBe(POST_TEXT);
            expect(recorded.targetHandle).toBe(TEST_HANDLE);
            expect(recorded.parentUri).toBe(PARENT_URI);
            expect(recorded.parentCid).toBe(PARENT_CID);
            expect(recorded.reason).toBe('Too aggressive');
            expect(recorded.rejectedAt).toBeDefined();
        });

        test('should persist DM rejection to backend', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction(
                `bsky-dm-reject-reason:${TEST_UUID}`,
                'Not appropriate',
                {
                    description: DM_TEXT,
                    fields:      [
                        { name: 'Recipients',      value: JSON.stringify([DM_HANDLE_ALICE, DM_HANDLE_BOB]) },
                        { name: 'Conversation ID', value: DM_CONVO_ID },
                    ],
                }
            );

            await handler.handleModalSubmit(interaction);

            expect(deps.rejectionBackend.recordRejection).toHaveBeenCalledTimes(1);
            const recorded = (deps.rejectionBackend.recordRejection as ReturnType<typeof mock>).mock.calls[0][0];
            expect(recorded.type).toBe('dm');
            expect(recorded.text).toBe(DM_TEXT);
            expect(recorded.recipientHandles).toEqual([DM_HANDLE_ALICE, DM_HANDLE_BOB]);
            expect(recorded.convoId).toBe(DM_CONVO_ID);
            expect(recorded.reason).toBe('Not appropriate');
        });

        test('should log info with rejection details after successful reply rejection', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction(
                `bsky-send-reject-reason:${TEST_UUID}`,
                'Too aggressive',
                { description: POST_TEXT, fields: makeEmbedFields() }
            );

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.info).toHaveBeenCalledTimes(1);
            const infoArg = (mockLogger.info as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
            expect(infoArg.type).toBe('reply');
            expect(infoArg.reason).toBe('Too aggressive');
            expect(infoArg.target).toBe(TEST_HANDLE);
            expect(infoArg.text).toBe(POST_TEXT);
            expect(infoArg.msg).toBe('Bsky post rejected by admin');
        });

        test('should log info with rejection details after successful DM rejection', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction(
                `bsky-dm-reject-reason:${TEST_UUID}`,
                'Not appropriate',
                {
                    description: DM_TEXT,
                    fields:      [
                        { name: 'Recipients',      value: JSON.stringify([DM_HANDLE_ALICE, DM_HANDLE_BOB]) },
                        { name: 'Conversation ID', value: DM_CONVO_ID },
                    ],
                }
            );

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.info).toHaveBeenCalledTimes(1);
            const infoArg = (mockLogger.info as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
            expect(infoArg.type).toBe('dm');
            expect(infoArg.reason).toBe('Not appropriate');
            expect(infoArg.target).toBe(`${DM_HANDLE_ALICE}, ${DM_HANDLE_BOB}`);
            expect(infoArg.text).toBe(DM_TEXT);
            expect(infoArg.msg).toBe('Bsky post rejected by admin');
        });

        test('should not log info when rejection persistence fails', async () => {
            const deps = makeDeps();
            (deps.rejectionBackend.recordRejection as ReturnType<typeof mock>).mockRejectedValueOnce(new Error('DynamoDB timeout'));
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction(
                `bsky-send-reject-reason:${TEST_UUID}`,
                'Not appropriate',
                { description: POST_TEXT, fields: makeEmbedFields() }
            );

            await handler.handleModalSubmit(interaction);

            expect(mockLogger.info).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('should persist reply with root URI/CID when present', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction } = makeModalInteraction(
                `bsky-send-reject-reason:${TEST_UUID}`,
                'Off topic',
                { description: POST_TEXT, fields: makeEmbedFields({ rootUri: ROOT_URI, rootCid: ROOT_CID }) }
            );

            await handler.handleModalSubmit(interaction);

            const recorded = (deps.rejectionBackend.recordRejection as ReturnType<typeof mock>).mock.calls[0][0];
            expect(recorded.rootUri).toBe(ROOT_URI);
            expect(recorded.rootCid).toBe(ROOT_CID);
        });

        test('should still update Discord embed when rejection persistence fails', async () => {
            const deps = makeDeps();
            (deps.rejectionBackend.recordRejection as ReturnType<typeof mock>).mockRejectedValueOnce(new Error('DynamoDB timeout'));
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, editReply } = makeModalInteraction(
                `bsky-send-reject-reason:${TEST_UUID}`,
                'Not appropriate',
                { description: POST_TEXT, fields: makeEmbedFields() }
            );

            await handler.handleModalSubmit(interaction);

            // editReply should still be called despite persistence failure
            expect(editReply).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('should handle missing embed gracefully (no message property)', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            // Create modal interaction WITHOUT embed data (message is undefined)
            const { interaction, editReply } = makeModalInteraction(
                `bsky-send-reject-reason:${TEST_UUID}`,
                'Not appropriate'
            );

            await handler.handleModalSubmit(interaction);

            // Should still update Discord embed, just skip persistence
            expect(editReply).toHaveBeenCalledTimes(1);
            expect(deps.rejectionBackend.recordRejection).not.toHaveBeenCalled();
        });

        test('should persist rejection with defaults when embed has no fields', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);

            // Create a modal interaction with an embed that has description but no fields
            const deferUpdate = mock(async () => ({}));
            const editReply   = mock(async () => ({}));
            const interaction = {
                customId: `bsky-send-reject-reason:${TEST_UUID}`,
                message:  {
                    embeds: [{
                        description: 'Some draft text',
                        // No fields property
                    }],
                },
                fields: {
                    getTextInputValue: mock((_fieldId: string) => 'Bad tone'),
                },
                deferUpdate,
                editReply,
            } as unknown as ModalSubmitInteraction;

            await handler.handleModalSubmit(interaction);

            expect(deps.rejectionBackend.recordRejection).toHaveBeenCalledTimes(1);
            const recorded = (deps.rejectionBackend.recordRejection as ReturnType<typeof mock>).mock.calls[0][0];
            expect(recorded.type).toBe('reply');
            expect(recorded.text).toBe('Some draft text');
            // All field-extracted values should be empty defaults since no fields exist
            expect(recorded.targetHandle).toBe('');
            expect(recorded.parentUri).toBe('');
            expect(recorded.parentCid).toBe('');
            expect(recorded.rootUri).toBeUndefined();
            expect(recorded.rootCid).toBeUndefined();
            expect(recorded.reason).toBe('Bad tone');
        });
    });

    // ---------------------------------------------------------------------------
    // DM button handlers
    // ---------------------------------------------------------------------------

    describe('handleButton() — DM flows', () => {
        test('should return early for unknown prefix (dm path)', async () => {
            const deps    = makeDeps();
            const handler = new BskyOutboundApprovalHandler(deps);
            const { interaction, deferUpdate } = makeDMButtonInteraction('bsky-other:42');

            await handler.handleButton(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
        });

        describe('bsky-dm-approve', () => {
            test('should deferUpdate, call sendDirectMessage, show success embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, deferUpdate, editReply } = makeDMButtonInteraction(`bsky-dm-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deferUpdate).toHaveBeenCalledTimes(1);
                expect(deps.client.sendDirectMessage).toHaveBeenCalledTimes(1);
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should call sendDirectMessage with convoId from embed and DM text', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeDMButtonInteraction(`bsky-dm-approve:${TEST_UUID}`, {
                    text:    DM_TEXT,
                    convoId: DM_CONVO_ID,
                });

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).toHaveBeenCalledWith(DM_CONVO_ID, DM_TEXT);
            });

            test('should show "DM Sent ✓" in embed title', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeDMButtonInteraction(`bsky-dm-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
                expect(replyArg.embeds[0]?.data?.title).toContain('DM Sent');
            });

            test('should clear buttons in success editReply', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeDMButtonInteraction(`bsky-dm-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: unknown[], components: unknown[] };
                expect(replyArg.embeds).toHaveLength(1);
                expect(replyArg.components).toHaveLength(0);
            });

            test('should throw if convoId is missing from embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const interaction = {
                    customId: `bsky-dm-approve:${TEST_UUID}`,
                    message:  {
                        embeds: [{
                            description: DM_TEXT,
                            fields:      [],  // no fields — no convoId
                        }],
                    },
                    deferUpdate: mock(async () => ({})),
                    editReply:   mock(async () => ({})),
                    showModal:   mock(async () => ({})),
                } as unknown as ButtonInteraction;

                await handler.handleButton(interaction);

                expect(mockLogger.error).toHaveBeenCalled();
            });

            test('should NOT add to allowlist on plain DM approve', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeDMButtonInteraction(`bsky-dm-approve:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
            });
        });

        describe('bsky-dm-approveallowlist', () => {
            test('should deferUpdate, call sendDirectMessage, add recipients to allowlist, show success embed', async () => {
                const deps    = makeDeps();
                // Override getProfile to return the correct handle for each call
                (deps.client.getProfile as ReturnType<typeof mock>)
                    .mockResolvedValueOnce({ did: DM_DID_ALICE, handle: DM_HANDLE_ALICE });
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, deferUpdate, editReply } = makeDMButtonInteraction(
                    `bsky-dm-approveallowlist:${TEST_UUID}`,
                    { recipientHandles: [DM_HANDLE_ALICE] }
                );

                await handler.handleButton(interaction);

                expect(deferUpdate).toHaveBeenCalledTimes(1);
                expect(deps.client.sendDirectMessage).toHaveBeenCalledTimes(1);
                expect(deps.client.getProfile).toHaveBeenCalledWith(DM_HANDLE_ALICE);
                expect(deps.allowlist.addEntry).toHaveBeenCalledTimes(1);
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should add all recipients to allowlist when multiple handles', async () => {
                const deps = makeDeps();
                (deps.client.getProfile as ReturnType<typeof mock>)
                    .mockResolvedValueOnce({ did: DM_DID_ALICE, handle: DM_HANDLE_ALICE })
                    .mockResolvedValueOnce({ did: DM_DID_BOB, handle: DM_HANDLE_BOB });
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeDMButtonInteraction(
                    `bsky-dm-approveallowlist:${TEST_UUID}`,
                    { recipientHandles: [DM_HANDLE_ALICE, DM_HANDLE_BOB] }
                );

                await handler.handleButton(interaction);

                expect(deps.allowlist.addEntry).toHaveBeenCalledTimes(2);
            });

            test('should show "DM Sent ✓ (handles allowlisted)" in embed title on allowlist success', async () => {
                const deps    = makeDeps();
                (deps.client.getProfile as ReturnType<typeof mock>)
                    .mockResolvedValueOnce({ did: DM_DID_ALICE, handle: DM_HANDLE_ALICE });
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeDMButtonInteraction(
                    `bsky-dm-approveallowlist:${TEST_UUID}`,
                    { recipientHandles: [DM_HANDLE_ALICE] }
                );

                await handler.handleButton(interaction);

                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
                expect(replyArg.embeds[0]?.data?.title).toContain('allowlisted');
            });

            test('should still complete DM when allowlist addEntry fails, shows "allowlist failed"', async () => {
                const deps = makeDeps();
                (deps.client.getProfile as ReturnType<typeof mock>)
                    .mockResolvedValueOnce({ did: DM_DID_ALICE, handle: DM_HANDLE_ALICE });
                (deps.allowlist.addEntry as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB error'));
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeDMButtonInteraction(
                    `bsky-dm-approveallowlist:${TEST_UUID}`,
                    { recipientHandles: [DM_HANDLE_ALICE] }
                );

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn).toHaveBeenCalled();
                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
                expect(replyArg.embeds[0]?.data?.title).toContain('allowlist failed');
            });

            test('should still complete DM when getProfile fails for a recipient', async () => {
                const deps = makeDeps();
                (deps.client.getProfile as ReturnType<typeof mock>)
                    .mockRejectedValue(new Error('profile fetch failed'));
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeDMButtonInteraction(
                    `bsky-dm-approveallowlist:${TEST_UUID}`,
                    { recipientHandles: [DM_HANDLE_ALICE] }
                );

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).toHaveBeenCalledTimes(1);
                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
                expect(mockLogger.warn).toHaveBeenCalled();
                expect(editReply).toHaveBeenCalledTimes(1);
            });

            test('should call sendDirectMessage with exact convoId from embed field', async () => {
                // Mutants 15/16: ConditionalExpression/EqualityOperator on convoId field lookup
                const deps = makeDeps();
                (deps.client.getProfile as ReturnType<typeof mock>)
                    .mockResolvedValueOnce({ did: DM_DID_ALICE, handle: DM_HANDLE_ALICE });
                const handler = new BskyOutboundApprovalHandler(deps);
                const customConvoId = 'specific-convo-xyz';
                const { interaction } = makeDMButtonInteraction(
                    `bsky-dm-approveallowlist:${TEST_UUID}`,
                    { recipientHandles: [DM_HANDLE_ALICE], convoId: customConvoId }
                );

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).toHaveBeenCalledWith(customConvoId, DM_TEXT);
            });

            test('should parse recipient handles from Recipients embed field and add each to allowlist', async () => {
                // Mutant 17: ConditionalExpression on recipientsValue field lookup
                const deps = makeDeps();
                (deps.client.getProfile as ReturnType<typeof mock>)
                    .mockResolvedValueOnce({ did: DM_DID_ALICE, handle: DM_HANDLE_ALICE })
                    .mockResolvedValueOnce({ did: DM_DID_BOB, handle: DM_HANDLE_BOB });
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction } = makeDMButtonInteraction(
                    `bsky-dm-approveallowlist:${TEST_UUID}`,
                    { recipientHandles: [DM_HANDLE_ALICE, DM_HANDLE_BOB] }
                );

                await handler.handleButton(interaction);

                expect(deps.client.getProfile).toHaveBeenCalledWith(DM_HANDLE_ALICE);
                expect(deps.client.getProfile).toHaveBeenCalledWith(DM_HANDLE_BOB);
                expect(deps.allowlist.addEntry).toHaveBeenCalledTimes(2);
            });

            test('should show "allowlist failed" when one of multiple allowlist writes fails', async () => {
                // Mutant 18: every → some — if "some" were used, partial success would show success title
                const deps = makeDeps();
                (deps.client.getProfile as ReturnType<typeof mock>)
                    .mockResolvedValueOnce({ did: DM_DID_ALICE, handle: DM_HANDLE_ALICE })
                    .mockResolvedValueOnce({ did: DM_DID_BOB, handle: DM_HANDLE_BOB });
                // Alice's addEntry succeeds, Bob's fails
                (deps.allowlist.addEntry as ReturnType<typeof mock>)
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(new Error('DynamoDB throttled'));
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply } = makeDMButtonInteraction(
                    `bsky-dm-approveallowlist:${TEST_UUID}`,
                    { recipientHandles: [DM_HANDLE_ALICE, DM_HANDLE_BOB] }
                );

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn).toHaveBeenCalled();
                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
                expect(replyArg.embeds[0]?.data?.title).toContain('allowlist failed');
            });

            test('should send DM and not call addEntry when Recipients field is absent from embed', async () => {
                // Covers the [] fallback in recipientHandles when recipientsValue is undefined
                // Mutant: [] → ["Stryker was here"] would cause addEntry to be called with a spurious handle
                const deps = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const fields: { name: string, value: string, inline: boolean }[] = [
                    { name: 'Conversation ID', value: DM_CONVO_ID, inline: true },
                    // No 'Recipients' field
                ];
                const interaction = {
                    customId: `bsky-dm-approveallowlist:${TEST_UUID}`,
                    message:  {
                        embeds: [{
                            description: DM_TEXT,
                            fields,
                        }],
                    },
                    deferUpdate: mock(async () => ({})),
                    editReply:   mock(async () => ({})),
                    showModal:   mock(async () => ({})),
                } as unknown as ButtonInteraction;

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).toHaveBeenCalledTimes(1);
                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
            });

            test('should throw if convoId is missing from embed', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const interaction = {
                    customId: `bsky-dm-approveallowlist:${TEST_UUID}`,
                    message:  {
                        embeds: [{
                            description: DM_TEXT,
                            fields:      [
                                { name: 'Recipients', value: JSON.stringify([DM_HANDLE_ALICE]), inline: false },
                                // Conversation ID intentionally omitted
                            ],
                        }],
                    },
                    deferUpdate: mock(async () => ({})),
                    editReply:   mock(async () => ({})),
                    showModal:   mock(async () => ({})),
                } as unknown as ButtonInteraction;

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).not.toHaveBeenCalled();
                expect(mockLogger.error).toHaveBeenCalled();
            });
        });

        describe('bsky-dm-reject', () => {
            test('should show a modal for rejection reason without deferUpdate', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, deferUpdate, showModal } = makeDMButtonInteraction(`bsky-dm-reject:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(deferUpdate).not.toHaveBeenCalled();
                expect(showModal).toHaveBeenCalledTimes(1);
                expect(deps.client.sendDirectMessage).not.toHaveBeenCalled();
            });

            test('should show modal with customId containing bsky-dm-reject-reason prefix and original uuid', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, showModal } = makeDMButtonInteraction(`bsky-dm-reject:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(showModal).toHaveBeenCalledTimes(1);
                const modalArg = showModal.mock.calls[0]?.[0] as { data: { custom_id: string } };
                expect(modalArg.data?.custom_id).toContain('bsky-dm-reject-reason');
                expect(modalArg.data?.custom_id).toContain(TEST_UUID);
            });

            test('should NOT call editReply when DM reject path (showModal) throws', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, editReply, showModal } = makeDMButtonInteraction(`bsky-dm-reject:${TEST_UUID}`);
                showModal.mockRejectedValue(new Error('modal failed'));

                await handler.handleButton(interaction);

                expect(editReply).not.toHaveBeenCalled();
                expect(mockLogger.error).toHaveBeenCalled();
            });

            test('should show modal with title "Reject Bluesky DM" for bsky-dm-reject', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const { interaction, showModal } = makeDMButtonInteraction(`bsky-dm-reject:${TEST_UUID}`);

                await handler.handleButton(interaction);

                expect(showModal).toHaveBeenCalledTimes(1);
                const modalArg = showModal.mock.calls[0]?.[0] as { data: { title: string } };
                expect(modalArg.data?.title).toBe('Reject Bluesky DM');
            });
        });

        describe('bsky-dm-approveallowlist — malformed JSON and empty recipients', () => {
            test('should still send DM and show "allowlist failed" when Recipients field is malformed JSON', async () => {
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const fields: { name: string, value: string, inline: boolean }[] = [
                    { name: 'Recipients',      value: 'not-valid-json', inline: false },
                    { name: 'Conversation ID', value: DM_CONVO_ID,      inline: true },
                ];
                const interaction = {
                    customId: `bsky-dm-approveallowlist:${TEST_UUID}`,
                    message:  {
                        embeds: [{
                            description: DM_TEXT,
                            fields,
                        }],
                    },
                    deferUpdate: mock(async () => ({})),
                    editReply:   mock(async () => ({})),
                    showModal:   mock(async () => ({})),
                } as unknown as ButtonInteraction;

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).toHaveBeenCalledWith(DM_CONVO_ID, DM_TEXT);
                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
                expect(mockLogger.warn).toHaveBeenCalled();
                const { editReply } = interaction as unknown as { editReply: ReturnType<typeof mock> };
                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
                expect(replyArg.embeds[0]?.data?.title).toContain('allowlist failed');
            });

            test('should show "allowlist failed" when Recipients field is absent from embed (empty handles)', async () => {
                // Regression: .every([]) returns true — guard ensures empty recipientHandles shows "allowlist failed"
                const deps    = makeDeps();
                const handler = new BskyOutboundApprovalHandler(deps);
                const fields: { name: string, value: string, inline: boolean }[] = [
                    { name: 'Conversation ID', value: DM_CONVO_ID, inline: true },
                    // No 'Recipients' field
                ];
                const interaction = {
                    customId: `bsky-dm-approveallowlist:${TEST_UUID}`,
                    message:  {
                        embeds: [{
                            description: DM_TEXT,
                            fields,
                        }],
                    },
                    deferUpdate: mock(async () => ({})),
                    editReply:   mock(async () => ({})),
                    showModal:   mock(async () => ({})),
                } as unknown as ButtonInteraction;

                await handler.handleButton(interaction);

                expect(deps.client.sendDirectMessage).toHaveBeenCalledTimes(1);
                expect(deps.allowlist.addEntry).not.toHaveBeenCalled();
                const { editReply } = interaction as unknown as { editReply: ReturnType<typeof mock> };
                const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string } }[] };
                expect(replyArg.embeds[0]?.data?.title).toContain('allowlist failed');
            });
        });
    });
});
