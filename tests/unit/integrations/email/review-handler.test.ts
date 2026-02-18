import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mockLogger } from '../../../setup';
import { ReviewHandler } from '@/integrations/email/review-handler';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import type { EmailCounterStore } from '@/integrations/email/email-counters';
import type { ImapConnection } from '@/integrations/email/imap-connection';
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

function makeImap(email?: EmailMetadata): {
    conn:             ImapConnection
    moveMessage:      ReturnType<typeof mock>
    fetchMessage:     ReturnType<typeof mock>
    getMailboxCounts: ReturnType<typeof mock>
} {
    const moveMessage      = mock(async () => undefined);
    const fetchMessage     = mock(async () => email ?? makeEmail());
    const getMailboxCounts = mock(async () => ({ total: 5, unread: 2 }));
    return {
        conn: { moveMessage, fetchMessage, getMailboxCounts } as unknown as ImapConnection,
        moveMessage,
        fetchMessage,
        getMailboxCounts,
    };
}

function makeCounters(): {
    store: EmailCounterStore
    reset: ReturnType<typeof mock>
} {
    const reset = mock(async () => undefined);
    return {
        store: { reset } as unknown as EmailCounterStore,
        reset,
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
        test('rejects non-Craig user with ephemeral reply and no IMAP calls', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42:Review', 'other-user-id');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, ephemeral: boolean };
            expect(replyArg.content).toBe('Only the admin can review emails.');
            expect(replyArg.ephemeral).toBe(true);
            expect(imap.moveMessage).not.toHaveBeenCalled();
            expect(deferUpdate).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('allows Craig user to proceed normally', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, reply, deferUpdate } = makeInteraction('email-trash:42:Review', CRAIG_ID);

            await handler.handleButton(interaction);

            expect(reply).not.toHaveBeenCalled();
            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(imap.moveMessage).toHaveBeenCalled();
        });

        test('uses the configured adminDiscordUserId, not a hardcoded constant', async () => {
            const customUserId = 'custom-user-id-99999';
            const imap         = makeImap();
            const counters     = makeCounters();
            const allowlist    = makeAllowlist();
            const handler      = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: customUserId });

            // Custom configured user should be allowed
            const { interaction: allowedInteraction, reply: allowedReply } = makeInteraction('email-trash:42:Review', customUserId);
            await handler.handleButton(allowedInteraction);
            expect(allowedReply).not.toHaveBeenCalled();
            expect(imap.moveMessage).toHaveBeenCalled();

            // Default CRAIG_ID should be rejected since different user configured
            imap.moveMessage.mockClear();
            const { interaction: rejectedInteraction, reply: rejectedReply } = makeInteraction('email-trash:42:Review', CRAIG_ID);
            await handler.handleButton(rejectedInteraction);
            expect(rejectedReply).toHaveBeenCalledTimes(1);
            expect(imap.moveMessage).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // email-trash button
    // -------------------------------------------------------------------------

    describe('email-trash button', () => {
        test('moves email from Review to Trash', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).toHaveBeenCalledWith(42, 'Review', 'Trash');
        });

        test('moves email from Quarantine to Trash', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-trash:42:Quarantine');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).toHaveBeenCalledWith(42, 'Quarantine', 'Trash');
        });

        test('calls deferUpdate immediately and updates embed with red color and Trashed title', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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

        test('does not call reset or addEntry', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(counters.reset).not.toHaveBeenCalled();
            expect(allowlist.addEntry).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // email-junk button
    // -------------------------------------------------------------------------

    describe('email-junk button', () => {
        test('moves email from Review to Junk', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-junk:42:Review');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).toHaveBeenCalledWith(42, 'Review', 'Junk');
        });

        test('calls deferUpdate immediately and updates embed with red color and Junked title', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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

        test('does not call reset or addEntry', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-junk:42:Review');

            await handler.handleButton(interaction);

            expect(counters.reset).not.toHaveBeenCalled();
            expect(allowlist.addEntry).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // email-allow button
    // -------------------------------------------------------------------------

    describe('email-allow button', () => {
        test('moves email from Review to CleanInbox', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allow:42:Review');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).toHaveBeenCalledWith(42, 'Review', 'CleanInbox');
        });

        test('moves email from Quarantine to CleanInbox', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allow:42:Quarantine');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).toHaveBeenCalledWith(42, 'Quarantine', 'CleanInbox');
        });

        test('syncs counters from IMAP', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allow:42:Review');

            await handler.handleButton(interaction);

            expect(imap.getMailboxCounts).toHaveBeenCalledWith('CleanInbox');
            expect(counters.reset).toHaveBeenCalledTimes(1);
        });

        test('calls deferUpdate immediately and updates embed with green color and Allowed title', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(imap.fetchMessage).toHaveBeenCalledWith('Review', 42);
        });

        test('moves email from Review to CleanInbox', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).toHaveBeenCalledWith(42, 'Review', 'CleanInbox');
        });

        test('syncs counters from IMAP', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            expect(imap.getMailboxCounts).toHaveBeenCalledWith('CleanInbox');
            expect(counters.reset).toHaveBeenCalledTimes(1);
        });

        test('adds sender to allowlist with name when present', async () => {
            const email     = makeEmail({ from: { name: 'Alice Sender', address: 'alice@example.com' } });
            const imap      = makeImap(email);
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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
            const imap      = makeImap(email);
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            const entryArg = allowlist.addEntry.mock.calls[0]?.[0] as { email: string, name?: string };
            expect(entryArg.email).toBe('alice@example.com');
            expect(entryArg.name).toBeUndefined();
        });

        test('calls deferUpdate immediately and updates embed with green color and allowlist title', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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

        test('allowlist write fails after successful move: editReply shows recovery message', async () => {
            const email     = makeEmail({ from: { name: 'Alice Sender', address: 'alice@example.com' } });
            const imap      = makeImap(email);
            const counters  = makeCounters();
            const addEntry  = mock(async () => {
                throw new Error('DynamoDB write failed');
            });
            const allowlist = { list: { addEntry } as unknown as EmailAllowlist, addEntry };
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply } = makeInteraction('email-allowlist:42:Review');

            await handler.handleButton(interaction);

            // move still happened
            expect(imap.moveMessage).toHaveBeenCalledWith(42, 'Review', 'CleanInbox');
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
        test('replies with error for invalid folder and no IMAP calls', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42:InvalidFolder');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, ephemeral: boolean };
            expect(replyArg.content).toBe('Invalid folder in button interaction.');
            expect(replyArg.ephemeral).toBe(true);
            expect(imap.moveMessage).not.toHaveBeenCalled();
            expect(deferUpdate).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('replies with error when folder part is missing', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, reply, editReply, deferUpdate } = makeInteraction('email-trash:42');

            await handler.handleButton(interaction);

            expect(reply).toHaveBeenCalledTimes(1);
            const replyArg = reply.mock.calls[0]?.[0] as { content: string, ephemeral: boolean };
            expect(replyArg.content).toBe('Invalid folder in button interaction.');
            expect(replyArg.ephemeral).toBe(true);
            expect(imap.moveMessage).not.toHaveBeenCalled();
            expect(deferUpdate).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // Invalid UID in customId
    // -------------------------------------------------------------------------

    describe('invalid UID in customId', () => {
        test('ignores email-trash button with missing UID part', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply } = makeInteraction('email-trash');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('ignores email-allow button with non-numeric UID', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply } = makeInteraction('email-allow:notanumber:Review');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // Unknown button prefix
    // -------------------------------------------------------------------------

    describe('unknown button prefix', () => {
        test('ignores buttons that do not match email-* pattern', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply } = makeInteraction('question:abc:opt1');

            await handler.handleButton(interaction);

            expect(imap.moveMessage).not.toHaveBeenCalled();
            expect(counters.reset).not.toHaveBeenCalled();
            expect(allowlist.addEntry).not.toHaveBeenCalled();
            expect(editReply).not.toHaveBeenCalled();
        });

        test('ignores email-unknown button', async () => {
            const imap      = makeImap();
            const counters  = makeCounters();
            const allowlist = makeAllowlist();
            const handler   = new ReviewHandler({ imap: imap.conn, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
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
            const moveMessage  = mock(async () => {
                throw new Error('IMAP failure');
            });
            const fetchMessage = mock(async () => makeEmail());
            const imap         = { moveMessage, fetchMessage } as unknown as ImapConnection;
            const counters     = makeCounters();
            const allowlist    = makeAllowlist();
            const handler      = new ReviewHandler({ imap, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const { interaction, editReply, deferUpdate } = makeInteraction('email-trash:42:Review');

            await handler.handleButton(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalled();
            expect(editReply).toHaveBeenCalledTimes(1);
            const editReplyArg = editReply.mock.calls[0]?.[0] as { content: string };
            expect(editReplyArg.content).toContain('error');
        });

        test('logs error when editReply also throws', async () => {
            const moveMessage  = mock(async () => {
                throw new Error('IMAP failure');
            });
            const fetchMessage = mock(async () => makeEmail());
            const imap         = { moveMessage, fetchMessage } as unknown as ImapConnection;
            const counters     = makeCounters();
            const allowlist    = makeAllowlist();
            const handler      = new ReviewHandler({ imap, counters: counters.store, allowlist: allowlist.list, adminDiscordUserId: CRAIG_ID });
            const deferUpdate  = mock(async () => ({}));
            const editReply    = mock(async () => {
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
