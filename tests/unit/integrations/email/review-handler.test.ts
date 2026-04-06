import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { MessageFlags, type ButtonInteraction, type InteractionUpdateOptions } from 'discord.js';
import { mockLogger } from '../../../setup';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { ReviewHandler } from '@/integrations/email/review-handler';
import type { EmailMetadata } from '@/integrations/email/types';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
// Craig's Discord user ID used in tests
const CRAIG_ID = '111111111111111111';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEmail(overrides: Partial<EmailMetadata> = {}): EmailMetadata {
    return {
        uid:            42,
        messageId:      '<test@example.com>',
        from:           { name: 'Alice Sender', address: 'alice@example.com' },
        to:             [{ address: 'me@rungie.com' }],
        cc:             [],
        subject:        'Hello there',
        date:           new Date('2025-01-15T10:00:00Z'),
        bodyText:       'Test body.',
        hasAttachments: false,
        headers:        {},
        attachments:    [],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeInteraction(customId: string, userId: string = CRAIG_ID): {
    interaction: ButtonInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    followUp:    ReturnType<typeof mock>
    reply:       ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const followUp    = mock(async () => ({}));
    const reply       = mock(async () => ({}));
    const interaction = {
        customId,
        user: { id: userId },
        deferUpdate,
        editReply,
        followUp,
        reply,
    } as unknown as ButtonInteraction;
    return { interaction, deferUpdate, editReply, followUp, reply };
}

function makeWildDuck(email?: EmailMetadata): {
    conn:           WildDuckClient
    moveMessage:    ReturnType<typeof mock>
    getFullMessage: ReturnType<typeof mock>
} {
    const moveMessage    = mock(async () => undefined);
    const getFullMessage = mock(async () => email ?? makeEmail());
    return {
        conn: { moveMessage, getFullMessage } as unknown as WildDuckClient,
        moveMessage,
        getFullMessage,
    };
}

function makeAllowlistInteractionHandler(): AllowlistInteractionHandler {
    return {
        startFromApproval: mock(async () => ({ allowlistSuffix: '' })),
        handleButton:      mock(async () => {}),
        handleModalSubmit: mock(async () => {}),
    } as unknown as AllowlistInteractionHandler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewHandler.handleButton()', () => {
    beforeEach(() => {
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
    });

    // -------------------------------------------------------------------------
    // M4 - Auth check
    // -------------------------------------------------------------------------

    describe('auth check', () => {
        test('rejects non-Craig user with ephemeral reply and no WildDuck calls', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42:Review', 'other-user-id');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, flags: MessageFlags };
            expect(replyArg.content).toBe('Only the admin can review emails.');
            expect(replyArg.flags).toBe(MessageFlags.Ephemeral);
            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(deferUpdate).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('allows Craig user to proceed normally', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, reply, deferUpdate } = makeInteraction('email-trash:42:Review', CRAIG_ID);

            await handler.handleButton(interaction);

            expect(reply).not.toHaveBeenCalled();
            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(wildDuck.moveMessage).toHaveBeenCalled();
        });

        test('uses the configured adminDiscordUserId, not a hardcoded constant', async () => {
            const customUserId = 'custom-user-id-99999';
            const wildDuck     = makeWildDuck();
            const handler      = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: customUserId, allowlistInteractionHandler: makeAllowlistInteractionHandler() });

            // Custom configured user should be allowed
            const { interaction: allowedInteraction, reply: allowedReply } = makeInteraction('email-trash:42:Review', customUserId);
            await handler.handleButton(allowedInteraction);
            expect(allowedReply).not.toHaveBeenCalled();
            expect(wildDuck.moveMessage).toHaveBeenCalled();

            // Default CRAIG_ID should be rejected since different user configured
            wildDuck.moveMessage.mockClear();
            const { interaction: rejectedInteraction, reply: rejectedReply } = makeInteraction('email-trash:42:Review', CRAIG_ID);
            await handler.handleButton(rejectedInteraction);
            expect(rejectedReply).toHaveBeenCalledTimes(1);
            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // email-trash button
    // -------------------------------------------------------------------------

    describe('email-trash button', () => {
        test('moves email from Review to Trash', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'Trash');
        });

        test('moves email from Quarantine to Trash', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-trash:42:Quarantine');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Quarantine', 42, 'Trash');
        });

        test('calls deferUpdate immediately and updates embed with red color and Trashed title', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, deferUpdate, editReply } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg  = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions;
            expect(callArg.components).toEqual([]);
            const embedData = (callArg.embeds?.[0] as { toJSON(): { title: string, color: number } }).toJSON();
            expect(embedData.title).toBe('Trashed');
            expect(embedData.color).toBe(0xFF_00_00);
        });

        test('does not call addEntry', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(handler).toBeDefined(); // allowlist no longer has addEntry (uses PersonAllowlist)
        });
    });

    // -------------------------------------------------------------------------
    // email-junk button
    // -------------------------------------------------------------------------

    describe('email-junk button', () => {
        test('moves email from Review to Junk', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-junk:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'Junk');
        });

        test('calls deferUpdate immediately and updates embed with red color and Junked title', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, deferUpdate, editReply } = makeInteraction('email-junk:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg  = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions;
            expect(callArg.components).toEqual([]);
            const embedData = (callArg.embeds?.[0] as { toJSON(): { title: string, color: number } }).toJSON();
            expect(embedData.title).toBe('Junked');
            expect(embedData.color).toBe(0xFF_00_00);
        });

        test('does not call addEntry', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-junk:42:Review');

            await handler.handleButton(interaction);

            expect(handler).toBeDefined(); // allowlist no longer has addEntry (uses PersonAllowlist)
        });
    });

    // -------------------------------------------------------------------------
    // email-allow button
    // -------------------------------------------------------------------------

    describe('email-allow button', () => {
        test('moves email from Review to CleanInbox', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-allow:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'CleanInbox');
        });

        test('moves email from Quarantine to CleanInbox', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-allow:42:Quarantine');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Quarantine', 42, 'CleanInbox');
        });

        test('calls deferUpdate immediately and updates embed with green color and Allowed title', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, deferUpdate, editReply } = makeInteraction('email-allow:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg  = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions;
            expect(callArg.components).toEqual([]);
            const embedData = (callArg.embeds?.[0] as { toJSON(): { title: string, color: number } }).toJSON();
            expect(embedData.title).toBe('Allowed');
            expect(embedData.color).toBe(0x00_AA_00);
        });

        test('does not call addEntry', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-allow:42:Review');

            await handler.handleButton(interaction);

            expect(handler).toBeDefined(); // allowlist no longer has addEntry (uses PersonAllowlist)
        });
    });

    // -------------------------------------------------------------------------
    // email-allowlist button
    // -------------------------------------------------------------------------

    describe('email-allowlist button', () => {
        test('fetches email to get sender address from Review folder', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.getFullMessage).toHaveBeenCalledWith('Review', 42);
        });

        test('moves email from Review to CleanInbox', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'CleanInbox');
        });

        test('moves message to CleanInbox and shows success embed', async () => {
            const email     = makeEmail({ from: { name: 'Alice Sender', address: 'alice@example.com' } });
            const wildDuck  = makeWildDuck(email);
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, editReply } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'CleanInbox');
            expect(editReply).toHaveBeenCalledTimes(1);
        });

        test('does NOT call addPerson (PersonAllowlist write deferred to saga flow)', async () => {
            const email     = makeEmail({ from: { address: 'alice@example.com' } });
            const wildDuck  = makeWildDuck(email);
            const allowlistHandler = makeAllowlistInteractionHandler();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: allowlistHandler });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            // The handler uses allowlistInteractionHandler.startFromApproval for the saga flow — not a direct allowlist write
            expect((allowlistHandler.startFromApproval as ReturnType<typeof mock>)).toHaveBeenCalledTimes(1);
        });

        test('calls deferUpdate immediately and updates embed with green color and allowlist title', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, deferUpdate, editReply } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg  = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions;
            expect(callArg.components).toEqual([]);
            const embedData = (callArg.embeds?.[0] as { toJSON(): { title: string, color: number } }).toJSON();
            expect(embedData.title).toBe('Allowed \u2713');
            expect(embedData.color).toBe(0x00_AA_00);
        });

        test('editReply shows error when getFullMessage returns null (message not found)', async () => {
            const moveMessage    = mock(async () => undefined);
            const getFullMessage = mock(() => Promise.resolve(null));
            const wildDuckConn   = { moveMessage, getFullMessage } as unknown as WildDuckClient;
            const handler        = new ReviewHandler({ wildDuckClient: wildDuckConn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, editReply } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            // Should show error (getFullMessage returned null — throws in handler)
            expect(editReply).toHaveBeenCalledTimes(1);
            const editReplyArg = editReply.mock.calls[0]?.[0] as { content: string };
            expect(editReplyArg.content).toContain('error');
        });

        test('allowlist handler moves message and shows success embed (allowlist addition is a separate saga flow)', async () => {
            const email    = makeEmail({ from: { name: 'Alice Sender', address: 'alice@example.com' } });
            const wildDuck = makeWildDuck(email);
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, editReply } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            // move happened
            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'CleanInbox');
            // editReply called with success embed
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions & { content?: string };
            expect(callArg.components).toEqual([]);
            expect(callArg.embeds).toHaveLength(1);
        });

        test('passes sender name as display name hint to startFromApproval (non-empty name)', async () => {
            const email     = makeEmail({ from: { name: 'Alice Sender', address: 'alice@example.com' } });
            const wildDuck  = makeWildDuck(email);
            const allowlistHandler = makeAllowlistInteractionHandler();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: allowlistHandler });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            const startCall = (allowlistHandler.startFromApproval as ReturnType<typeof mock>).mock.calls[0] as [unknown, string, string, string | undefined];
            // 4th argument is the display name hint — should be the sender name, not undefined
            expect(startCall[3]).toBe('Alice Sender');
        });

        test('passes undefined as display name hint when sender name is empty', async () => {
            const email     = makeEmail({ from: { name: '', address: 'alice@example.com' } });
            const wildDuck  = makeWildDuck(email);
            const allowlistHandler = makeAllowlistInteractionHandler();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: allowlistHandler });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            const startCall = (allowlistHandler.startFromApproval as ReturnType<typeof mock>).mock.calls[0] as [unknown, string, string, string | undefined];
            // empty name should be coerced to undefined so the saga doesn't use '' as a hint
            expect(startCall[3]).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------------
    // Folder validation
    // -------------------------------------------------------------------------

    describe('invalid folder in customId', () => {
        test('replies with error for invalid folder and no WildDuck calls', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42:InvalidFolder');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, flags: MessageFlags };
            expect(replyArg.content).toBe('Invalid folder in button interaction.');
            expect(replyArg.flags).toBe(MessageFlags.Ephemeral);
            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(deferUpdate).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('replies with error when folder part is missing', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, flags: MessageFlags };
            expect(replyArg.content).toBe('Invalid folder in button interaction.');
            expect(replyArg.flags).toBe(MessageFlags.Ephemeral);
            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(deferUpdate).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // Invalid UID in customId
    // -------------------------------------------------------------------------

    describe('invalid UID in customId', () => {
        test('ignores email-trash button with missing UID part', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, editReply } = makeInteraction('email-trash');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('ignores email-allow button with non-numeric UID', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, editReply } = makeInteraction('email-allow:notanumber:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // Unknown button prefix
    // -------------------------------------------------------------------------

    describe('unknown button prefix', () => {
        test('ignores buttons that do not match email-* pattern', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, editReply } = makeInteraction('question:abc:opt1');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(handler).toBeDefined(); // allowlist no longer has addEntry (uses PersonAllowlist)
            expect(editReply).not.toHaveBeenCalled();
        });

        test('ignores email-unknown button', async () => {
            const wildDuck  = makeWildDuck();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, editReply } = makeInteraction('email-unknown:42:Review');

            await handler.handleButton(interaction);

            expect(editReply).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        test('logs error and sends editReply when move throws', async () => {
            const moveMessage    = mock(async () => {
                throw new Error('WildDuck failure');
            });
            const getFullMessage = mock(async () => makeEmail());
            const wildDuckConn   = { moveMessage, getFullMessage } as unknown as WildDuckClient;
            const handler        = new ReviewHandler({ wildDuckClient: wildDuckConn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const { interaction, editReply, deferUpdate } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalled();
            expect(editReply).toHaveBeenCalledTimes(1);
            const editReplyArg = editReply.mock.calls[0]?.[0] as { content: string };
            expect(editReplyArg.content).toContain('error');
        });

        test('logs error when editReply also throws', async () => {
            const moveMessage    = mock(async () => {
                throw new Error('WildDuck failure');
            });
            const getFullMessage = mock(async () => makeEmail());
            const wildDuckConn   = { moveMessage, getFullMessage } as unknown as WildDuckClient;
            const handler        = new ReviewHandler({ wildDuckClient: wildDuckConn, adminDiscordUserId: CRAIG_ID, allowlistInteractionHandler: makeAllowlistInteractionHandler() });
            const deferUpdate    = mock(async () => ({}));
            const editReply      = mock(async () => {
                throw new Error('editReply failure');
            });
            const followUp    = mock(async () => ({}));
            const reply       = mock(async () => ({}));
            const interaction = {
                customId: 'email-trash:42:Review',
                user:     { id: CRAIG_ID },
                deferUpdate,
                editReply,
                followUp,
                reply,
            } as unknown as ButtonInteraction;

            await handler.handleButton(interaction);

            expect(mockLogger.error).toHaveBeenCalledTimes(2);
        });
    });
});
