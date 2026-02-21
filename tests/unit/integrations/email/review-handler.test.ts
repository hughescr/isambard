import { describe, test, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import { mockLogger } from '../../../setup';
import { ReviewHandler } from '@/integrations/email/review-handler';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import type { EmailMetadata } from '@/integrations/email/types';
import type { ButtonInteraction, InteractionUpdateOptions } from 'discord.js';

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

function makeAllowlist(): {
    list:     EmailAllowlist
    addEntry: ReturnType<typeof mock>
} {
    const addEntry = mock(async () => undefined);
    return {
        list: { addEntry } as unknown as EmailAllowlist,
        addEntry,
    };
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
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42:Review', 'other-user-id');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, ephemeral: boolean };
            expect(replyArg.content).toBe('Only the admin can review emails.');
            expect(replyArg.ephemeral).toBe(true);
            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(deferUpdate).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('allows Craig user to proceed normally', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, reply, deferUpdate } = makeInteraction('email-trash:42:Review', CRAIG_ID);

            await handler.handleButton(interaction);

            expect(reply).not.toHaveBeenCalled();
            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(wildDuck.moveMessage).toHaveBeenCalled();
        });

        test('uses the configured adminDiscordUserId, not a hardcoded constant', async () => {
            const customUserId = 'custom-user-id-99999';
            const wildDuck     = makeWildDuck();
            const allowlist    = makeAllowlist();
            const handler      = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: customUserId });

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
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'Trash');
        });

        test('moves email from Quarantine to Trash', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-trash:42:Quarantine');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Quarantine', 42, 'Trash');
        });

        test('calls deferUpdate immediately and updates embed with red color and Trashed title', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, deferUpdate, editReply } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg  = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions;
            expect(callArg.components).toEqual([]);
            const embedData = (callArg.embeds?.[0] as { toJSON(): { title: string, color: number } }).toJSON();
            expect(embedData.title).toBe('Trashed');
            expect(embedData.color).toBe(0xFF0000);
        });

        test('does not call addEntry', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(allowlist.addEntry).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // email-junk button
    // -------------------------------------------------------------------------

    describe('email-junk button', () => {
        test('moves email from Review to Junk', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-junk:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'Junk');
        });

        test('calls deferUpdate immediately and updates embed with red color and Junked title', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, deferUpdate, editReply } = makeInteraction('email-junk:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg  = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions;
            expect(callArg.components).toEqual([]);
            const embedData = (callArg.embeds?.[0] as { toJSON(): { title: string, color: number } }).toJSON();
            expect(embedData.title).toBe('Junked');
            expect(embedData.color).toBe(0xFF0000);
        });

        test('does not call addEntry', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-junk:42:Review');

            await handler.handleButton(interaction);

            expect(allowlist.addEntry).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // email-allow button
    // -------------------------------------------------------------------------

    describe('email-allow button', () => {
        test('moves email from Review to CleanInbox', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allow:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'CleanInbox');
        });

        test('moves email from Quarantine to CleanInbox', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allow:42:Quarantine');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Quarantine', 42, 'CleanInbox');
        });

        test('calls deferUpdate immediately and updates embed with green color and Allowed title', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, deferUpdate, editReply } = makeInteraction('email-allow:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg  = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions;
            expect(callArg.components).toEqual([]);
            const embedData = (callArg.embeds?.[0] as { toJSON(): { title: string, color: number } }).toJSON();
            expect(embedData.title).toBe('Allowed');
            expect(embedData.color).toBe(0x00AA00);
        });

        test('does not call addEntry', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allow:42:Review');

            await handler.handleButton(interaction);

            expect(allowlist.addEntry).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // email-allowlist button
    // -------------------------------------------------------------------------

    describe('email-allowlist button', () => {
        test('fetches email to get sender address from Review folder', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.getFullMessage).toHaveBeenCalledWith('Review', 42);
        });

        test('moves email from Review to CleanInbox', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'CleanInbox');
        });

        test('adds sender to allowlist with name when present', async () => {
            const email     = makeEmail({ from: { name: 'Alice Sender', address: 'alice@example.com' } });
            const wildDuck  = makeWildDuck(email);
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(allowlist.addEntry).toHaveBeenCalledTimes(1);
            const entryArg = allowlist.addEntry.mock.calls[0]?.[0] as { email: string, name?: string, addedBy: string };
            expect(entryArg.email).toBe('alice@example.com');
            expect(entryArg.name).toBe('Alice Sender');
            expect(entryArg.addedBy).toBe('discord-review');
        });

        test('adds sender to allowlist without name when absent', async () => {
            const email     = makeEmail({ from: { address: 'alice@example.com' } });
            const wildDuck  = makeWildDuck(email);
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            const entryArg = allowlist.addEntry.mock.calls[0]?.[0] as { email: string, name?: string };
            expect(entryArg.email).toBe('alice@example.com');
            expect(entryArg.name).toBeUndefined();
        });

        test('calls deferUpdate immediately and updates embed with green color and allowlist title', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, deferUpdate, editReply } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg  = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions;
            expect(callArg.components).toEqual([]);
            const embedData = (callArg.embeds?.[0] as { toJSON(): { title: string, color: number } }).toJSON();
            expect(embedData.title).toBe('Allowed + Added to allowlist');
            expect(embedData.color).toBe(0x00AA00);
        });

        test('editReply shows error when getFullMessage returns null (message not found)', async () => {
            const moveMessage    = mock(async () => undefined);
            const getFullMessage = mock(_.constant(Promise.resolve(null)));
            const wildDuckConn   = { moveMessage, getFullMessage } as unknown as WildDuckClient;
            const allowlist      = makeAllowlist();
            const handler        = new ReviewHandler({ wildDuckClient: wildDuckConn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            // Should show error, not call addEntry
            expect(allowlist.addEntry).not.toHaveBeenCalled();
            expect(editReply).toHaveBeenCalledTimes(1);
            const editReplyArg = editReply.mock.calls[0]?.[0] as { content: string };
            expect(editReplyArg.content).toContain('error');
        });

        test('allowlist write fails after successful move: editReply shows recovery message', async () => {
            const email     = makeEmail({ from: { name: 'Alice Sender', address: 'alice@example.com' } });
            const wildDuck  = makeWildDuck(email);
            const addEntry  = mock(async () => {
                throw new Error('DynamoDB write failed');
            });
            const allowlist = { list: { addEntry } as unknown as EmailAllowlist, addEntry };
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            // move still happened
            expect(wildDuck.moveMessage).toHaveBeenCalledWith('Review', 42, 'CleanInbox');
            // editReply called with recovery message (not the generic error)
            expect(editReply).toHaveBeenCalledTimes(1);
            const callArg = editReply.mock.calls[0]?.[0] as InteractionUpdateOptions & { content?: string };
            expect(callArg.content).toContain('Email moved to CleanInbox');
            expect(callArg.content).toContain('failed to add to allowlist');
            expect(callArg.content).toContain('/allowlist add alice@example.com');
            expect(callArg.components).toEqual([]);
            // embed is still there (success embed for the move)
            expect(callArg.embeds).toHaveLength(1);
        });
    });

    // -------------------------------------------------------------------------
    // Folder validation
    // -------------------------------------------------------------------------

    describe('invalid folder in customId', () => {
        test('replies with error for invalid folder and no WildDuck calls', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42:InvalidFolder');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, ephemeral: boolean };
            expect(replyArg.content).toBe('Invalid folder in button interaction.');
            expect(replyArg.ephemeral).toBe(true);
            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(deferUpdate).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('replies with error when folder part is missing', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, ephemeral: boolean };
            expect(replyArg.content).toBe('Invalid folder in button interaction.');
            expect(replyArg.ephemeral).toBe(true);
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
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply } = makeInteraction('email-trash');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('ignores email-allow button with non-numeric UID', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply } = makeInteraction('question:abc:opt1');

            await handler.handleButton(interaction);

            expect(wildDuck.moveMessage).not.toHaveBeenCalled();
            expect(allowlist.addEntry).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('ignores email-unknown button', async () => {
            const wildDuck  = makeWildDuck();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ wildDuckClient: wildDuck.conn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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
            const allowlist      = makeAllowlist();
            const handler        = new ReviewHandler({ wildDuckClient: wildDuckConn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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
            const allowlist      = makeAllowlist();
            const handler        = new ReviewHandler({ wildDuckClient: wildDuckConn, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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
