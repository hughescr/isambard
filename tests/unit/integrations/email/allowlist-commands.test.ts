import { type Mock, describe, test, expect, beforeEach, mock  } from 'bun:test';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import { AllowlistCommandHandler, buildAllowlistCommand, type BskyAllowlistLike } from '@/integrations/email/allowlist-commands';
import type { AllowlistEntry } from '@/integrations/email/types';

// Admin Discord user ID used in tests
// Stryker disable next-line StringLiteral: Test admin user ID is a test configuration constant
const ADMIN_USER_ID = '423276934781468692';

// Minimal mock for EmailAllowlist
function createMockEmailAllowlist(): {
    list:        ReturnType<typeof mock>
    addEntry:    ReturnType<typeof mock>
    removeEntry: ReturnType<typeof mock>
} {
    return {
        list:        mock(async (): Promise<AllowlistEntry[]> => []),
        addEntry:    mock(async (_entry: AllowlistEntry): Promise<void> => {}),
        removeEntry: mock(async (_email: string): Promise<void> => {}),
    };
}

// Minimal mock for BskyAllowlistLike
function createMockBskyAllowlist(): {
    list:        ReturnType<typeof mock>
    addEntry:    ReturnType<typeof mock>
    removeEntry: ReturnType<typeof mock>
} {
    return {
        list:        mock(async (): Promise<{ handle: string, addedAt: string, notes?: string }[]> => []),
        addEntry:    mock(async (_entry: { handle: string, did?: string, notes?: string, addedAt: string, addedBy: string }): Promise<void> => {}),
        removeEntry: mock(async (_handle: string): Promise<void> => {}),
    };
}

interface MockInteraction {
    asChatInput: ChatInputCommandInteraction
    reply:       Mock<(...args: unknown[]) => Promise<void>>
    editReply:   Mock<(...args: unknown[]) => Promise<void>>
    deferReply:  Mock<(...args: unknown[]) => Promise<void>>
}

function createMockInteraction(
    userId:     string,
    subcommand: string,
    options:    Record<string, string | null> = {}
): MockInteraction {
    const replyMock: Mock<(...args: unknown[]) => Promise<void>> = mock(async () => {});
    const editReplyMock: Mock<(...args: unknown[]) => Promise<void>> = mock(async () => {});
    const deferReplyMock: Mock<(...args: unknown[]) => Promise<void>> = mock(async () => {});

    const interaction = {
        user:    { id: userId },
        options: {
            getSubcommand: mock(() => subcommand),
            getString:     mock((name: string) => options[name] ?? null),
        },
        reply:      replyMock,
        editReply:  editReplyMock,
        deferReply: deferReplyMock,
    } as unknown as ChatInputCommandInteraction;

    return {
        asChatInput: interaction,
        reply:       replyMock,
        editReply:   editReplyMock,
        deferReply:  deferReplyMock,
    };
}

describe('buildAllowlistCommand()', () => {
    test('returns a command with name "allowlist"', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        expect(json.name).toBe('allowlist');
    });

    test('returns a command with correct description', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        expect(json.description).toBe('Manage the email and Bluesky allowlists');
    });

    test('has list, add, and remove subcommands', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        const subcommands = json.options ?? [];
        const names = subcommands.map(s => s.name);
        expect(names).toContain('list');
        expect(names).toContain('add');
        expect(names).toContain('remove');
    });

    test('add subcommand has required address option', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        const addCmd = (json.options ?? []).find(o => o.name === 'add');
        expect(addCmd).toBeDefined();
        const addOptions: { name: string, required?: boolean }[] = (addCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const addressOpt = addOptions.find(o => o.name === 'address');
        expect(addressOpt).toBeDefined();
        expect(addressOpt?.required).toBe(true);
    });

    test('add subcommand has optional name and notes options', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        const addCmd = (json.options ?? []).find(o => o.name === 'add');
        const addOptions: { name: string, required?: boolean }[] = (addCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const nameOpt = addOptions.find(o => o.name === 'name');
        const notesOpt = addOptions.find(o => o.name === 'notes');
        expect(nameOpt).toBeDefined();
        expect(nameOpt?.required).toBeFalsy();
        expect(notesOpt).toBeDefined();
        expect(notesOpt?.required).toBeFalsy();
    });

    test('remove subcommand has required address option', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        const removeCmd = (json.options ?? []).find(o => o.name === 'remove');
        expect(removeCmd).toBeDefined();
        const removeOptions: { name: string, required?: boolean }[] = (removeCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const addressOpt = removeOptions.find(o => o.name === 'address');
        expect(addressOpt).toBeDefined();
        expect(addressOpt?.required).toBe(true);
    });

    test('sets contexts to Guild, BotDM, and PrivateChannel', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        expect(json.contexts).toEqual([0, 1, 2]);
    });

    test('sets integration types to GuildInstall only', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        expect(json.integration_types).toEqual([0]);
    });
});

describe('AllowlistCommandHandler - permission check', () => {
    test('replies with ephemeral denial for non-admin user', async () => {
        const mockEmailAllowlist = createMockEmailAllowlist();
        const mockBskyAllowlist  = createMockBskyAllowlist();
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID
        );
        const { asChatInput, reply } = createMockInteraction('999999999999999999', 'list');

        await handler.handle(asChatInput);

        expect(reply).toHaveBeenCalledWith({
            content: 'Only the admin can manage the allowlist.',
            flags:   MessageFlags.Ephemeral,
        });
        expect(mockEmailAllowlist.list).not.toHaveBeenCalled();
        expect(mockBskyAllowlist.list).not.toHaveBeenCalled();
    });

    test('does not call deferReply for non-admin user', async () => {
        const mockEmailAllowlist = createMockEmailAllowlist();
        const mockBskyAllowlist  = createMockBskyAllowlist();
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID
        );
        const { asChatInput, deferReply } = createMockInteraction('000000000000000000', 'list');

        await handler.handle(asChatInput);

        expect(deferReply).not.toHaveBeenCalled();
    });

    test('allows configured adminDiscordUserId to proceed', async () => {
        const mockEmailAllowlist = createMockEmailAllowlist();
        const mockBskyAllowlist  = createMockBskyAllowlist();
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID
        );
        const { asChatInput, reply, deferReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        expect(reply).not.toHaveBeenCalled();
        expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });

    test('allows custom adminDiscordUserId and rejects a different user', async () => {
        const customUserId       = '111222333444555666';
        const mockEmailAllowlist = createMockEmailAllowlist();
        const mockBskyAllowlist  = createMockBskyAllowlist();
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            customUserId
        );

        // Custom user ID should be allowed
        const { asChatInput: customUserInteraction, reply: customReply, deferReply: customDeferReply }
            = createMockInteraction(customUserId, 'list');
        await handler.handle(customUserInteraction);
        expect(customReply).not.toHaveBeenCalled();
        expect(customDeferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });

    test('rejects a different user when custom adminDiscordUserId is configured', async () => {
        const customUserId       = '111222333444555666';
        const mockEmailAllowlist = createMockEmailAllowlist();
        const mockBskyAllowlist  = createMockBskyAllowlist();
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            customUserId
        );

        // ADMIN_USER_ID should be rejected when a different custom ID is configured
        const { asChatInput: otherInteraction, reply: otherReply }
            = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(otherInteraction);
        expect(otherReply).toHaveBeenCalledWith({
            content: 'Only the admin can manage the allowlist.',
            flags:   MessageFlags.Ephemeral,
        });
        expect(mockEmailAllowlist.list).not.toHaveBeenCalled();
        expect(mockBskyAllowlist.list).not.toHaveBeenCalled();
    });
});

describe('AllowlistCommandHandler - /allowlist list', () => {
    let mockEmailAllowlist: ReturnType<typeof createMockEmailAllowlist>;
    let mockBskyAllowlist:  ReturnType<typeof createMockBskyAllowlist>;
    let handler:            AllowlistCommandHandler;

    beforeEach(() => {
        mockEmailAllowlist = createMockEmailAllowlist();
        mockBskyAllowlist  = createMockBskyAllowlist();
        handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID
        );
    });

    test('calls both list() methods', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        expect(mockEmailAllowlist.list).toHaveBeenCalledTimes(1);
        expect(mockBskyAllowlist.list).toHaveBeenCalledTimes(1);
    });

    test('replies with "No entries in either allowlist." when both are empty', async () => {
        mockEmailAllowlist.list.mockResolvedValue([]);
        mockBskyAllowlist.list.mockResolvedValue([]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('No entries in either allowlist.');
    });

    test('shows email entries with header when only email entries exist', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'alice@example.com', name: 'Alice', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
        ];
        mockEmailAllowlist.list.mockResolvedValue(entries);
        mockBskyAllowlist.list.mockResolvedValue([]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('\u{1F4E7} Email Allowlist:');
        expect(replyArg.content).toContain('alice@example.com');
        expect(replyArg.content).not.toContain('\u{1FAB7} Bluesky Allowlist:');
    });

    test('shows Bluesky entries with header when only bsky entries exist', async () => {
        mockEmailAllowlist.list.mockResolvedValue([]);
        mockBskyAllowlist.list.mockResolvedValue([
            { handle: 'alice.bsky.social', addedAt: '2026-03-10T00:00:00Z' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('\u{1FAB7} Bluesky Allowlist:');
        expect(replyArg.content).toContain('alice.bsky.social');
        expect(replyArg.content).not.toContain('\u{1F4E7} Email Allowlist:');
    });

    test('shows both sections when both lists have entries', async () => {
        const emailEntries: AllowlistEntry[] = [
            { email: 'alice@example.com', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
        ];
        mockEmailAllowlist.list.mockResolvedValue(emailEntries);
        mockBskyAllowlist.list.mockResolvedValue([
            { handle: 'bob.bsky.social', addedAt: '2026-03-10T00:00:00Z' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('\u{1F4E7} Email Allowlist:');
        expect(replyArg.content).toContain('alice@example.com');
        expect(replyArg.content).toContain('\u{1FAB7} Bluesky Allowlist:');
        expect(replyArg.content).toContain('bob.bsky.social');
    });

    test('formats email entry with name and notes as pipe-separated parts', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'alice@example.com', name: 'Alice', notes: 'Test user', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
        ];
        mockEmailAllowlist.list.mockResolvedValue(entries);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('**alice@example.com**');
        expect(replyArg.content).toContain('Name: Alice');
        expect(replyArg.content).toContain('Notes: Test user');
        expect(replyArg.content).toContain('Added: 2026-01-01T00:00:00Z');
        expect(replyArg.content).toContain('**alice@example.com** | Name: Alice | Notes: Test user | Added: 2026-01-01T00:00:00Z');
    });

    test('formats email entry without name when name is absent', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'bob@example.com', addedAt: '2026-01-02T00:00:00Z', addedBy: 'admin' },
        ];
        mockEmailAllowlist.list.mockResolvedValue(entries);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).not.toContain('Name:');
        expect(replyArg.content).toContain('**bob@example.com** | Added: 2026-01-02T00:00:00Z');
    });

    test('formats bsky entry with notes when present', async () => {
        mockBskyAllowlist.list.mockResolvedValue([
            { handle: 'carol.bsky.social', notes: 'Cool person', addedAt: '2026-03-01T00:00:00Z' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('**carol.bsky.social** | Notes: Cool person | Added: 2026-03-01T00:00:00Z');
    });

    test('formats bsky entry without notes when absent', async () => {
        mockBskyAllowlist.list.mockResolvedValue([
            { handle: 'dave.bsky.social', addedAt: '2026-03-02T00:00:00Z' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('**dave.bsky.social** | Added: 2026-03-02T00:00:00Z');
        expect(replyArg.content).not.toContain('Notes:');
    });

    test('separates multiple email entries with newlines', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'alice@example.com', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
            { email: 'bob@example.com',   addedAt: '2026-01-02T00:00:00Z', addedBy: 'admin' },
        ];
        mockEmailAllowlist.list.mockResolvedValue(entries);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        const content  = replyArg.content ?? '';
        expect(content).toContain('alice@example.com');
        expect(content).toContain('bob@example.com');
        // Both should appear in the email section
        const emailSection = content.split('\u{1FAB7}')[0] ?? content;
        expect(emailSection).toContain('alice@example.com');
        expect(emailSection).toContain('bob@example.com');
    });

    test('content starts with email section header when only email entries exist', async () => {
        mockEmailAllowlist.list.mockResolvedValue([
            { email: 'alice@example.com', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        const content = replyArg.content ?? '';
        // Content must start with the email section header — no spurious prefix
        expect(content).toBe('\u{1F4E7} Email Allowlist:\n**alice@example.com** | Added: 2026-01-01T00:00:00Z');
    });

    test('separates multiple email entries in section with newline between them', async () => {
        mockEmailAllowlist.list.mockResolvedValue([
            { email: 'alice@example.com', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
            { email: 'bob@example.com',   addedAt: '2026-01-02T00:00:00Z', addedBy: 'admin' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        // Entries must be separated by '\n' within the section — not concatenated
        expect(replyArg.content).toBe(
            '\u{1F4E7} Email Allowlist:\n'
            + '**alice@example.com** | Added: 2026-01-01T00:00:00Z\n'
            + '**bob@example.com** | Added: 2026-01-02T00:00:00Z'
        );
    });

    test('content starts with bsky section header when only bsky entries exist', async () => {
        mockBskyAllowlist.list.mockResolvedValue([
            { handle: 'alice.bsky.social', addedAt: '2026-03-10T00:00:00Z' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        const content = replyArg.content ?? '';
        // Content must start with the bsky section header — no spurious prefix
        expect(content).toBe('\u{1FAB7} Bluesky Allowlist:\n**alice.bsky.social** | Added: 2026-03-10T00:00:00Z');
    });

    test('separates sections with double newline when both email and bsky entries exist', async () => {
        mockEmailAllowlist.list.mockResolvedValue([
            { email: 'alice@example.com', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
        ]);
        mockBskyAllowlist.list.mockResolvedValue([
            { handle: 'bob.bsky.social', addedAt: '2026-03-10T00:00:00Z' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        // sections must be joined with '\n\n'
        expect(replyArg.content).toBe(
            '\u{1F4E7} Email Allowlist:\n**alice@example.com** | Added: 2026-01-01T00:00:00Z'
            + '\n\n'
            + '\u{1FAB7} Bluesky Allowlist:\n**bob.bsky.social** | Added: 2026-03-10T00:00:00Z'
        );
    });

    test('separates multiple bsky entries with newlines', async () => {
        mockBskyAllowlist.list.mockResolvedValue([
            { handle: 'alice.bsky.social', addedAt: '2026-03-10T00:00:00Z' },
            { handle: 'bob.bsky.social',   addedAt: '2026-03-11T00:00:00Z' },
        ]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        const content = replyArg.content ?? '';
        // The two entries must be separated by a single newline within the section
        expect(content).toContain('alice.bsky.social** | Added: 2026-03-10T00:00:00Z\n**bob.bsky.social');
    });

    test('defers reply before fetching list', async () => {
        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });

    test('handles list error gracefully', async () => {
        mockEmailAllowlist.list.mockRejectedValue(new Error('DynamoDB error'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to list allowlist entries');
    });
});

describe('AllowlistCommandHandler - /allowlist add', () => {
    let mockEmailAllowlist: ReturnType<typeof createMockEmailAllowlist>;
    let mockBskyAllowlist:  ReturnType<typeof createMockBskyAllowlist>;
    let handler:            AllowlistCommandHandler;

    beforeEach(() => {
        mockEmailAllowlist = createMockEmailAllowlist();
        mockBskyAllowlist  = createMockBskyAllowlist();
        handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID
        );
    });

    test('routes email address to emailAllowlist.addEntry', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(mockEmailAllowlist.addEntry).toHaveBeenCalledTimes(1);
        expect(mockBskyAllowlist.addEntry).not.toHaveBeenCalled();
        const callArg = mockEmailAllowlist.addEntry.mock.calls[0]?.[0] as AllowlistEntry;
        expect(callArg.email).toBe('alice@example.com');
        expect(callArg.addedBy).toBe('discord-command');
        expect(callArg.name).toBeUndefined();
        expect(callArg.notes).toBeUndefined();
        expect(callArg.addedAt).toBeDefined();
    });

    test('routes email address with name and notes to emailAllowlist.addEntry', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            address: 'bob@example.com',
            name:    'Bob',
            notes:   'Important contact',
        });
        await handler.handle(asChatInput);

        const callArg = mockEmailAllowlist.addEntry.mock.calls[0]?.[0] as AllowlistEntry;
        expect(callArg.email).toBe('bob@example.com');
        expect(callArg.name).toBe('Bob');
        expect(callArg.notes).toBe('Important contact');
        expect(callArg.addedBy).toBe('discord-command');
    });

    test('routes Bluesky handle to bskyAllowlist.addEntry', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'alice.bsky.social' });
        await handler.handle(asChatInput);

        expect(mockBskyAllowlist.addEntry).toHaveBeenCalledTimes(1);
        expect(mockEmailAllowlist.addEntry).not.toHaveBeenCalled();
        const callArg = mockBskyAllowlist.addEntry.mock.calls[0]?.[0] as { handle: string, addedBy: string };
        expect(callArg.handle).toBe('alice.bsky.social');
        expect(callArg.addedBy).toBe('discord-command');
    });

    test('strips leading @ from Bluesky handle', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { address: '@alice.bsky.social' });
        await handler.handle(asChatInput);

        expect(mockBskyAllowlist.addEntry).toHaveBeenCalledTimes(1);
        const callArg = mockBskyAllowlist.addEntry.mock.calls[0]?.[0] as { handle: string };
        expect(callArg.handle).toBe('alice.bsky.social');
    });

    test('passes notes to bskyAllowlist.addEntry', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            address: 'carol.bsky.social',
            notes:   'Tech blogger',
        });
        await handler.handle(asChatInput);

        const callArg = mockBskyAllowlist.addEntry.mock.calls[0]?.[0] as { handle: string, notes?: string };
        expect(callArg.handle).toBe('carol.bsky.social');
        expect(callArg.notes).toBe('Tech blogger');
    });

    test('replies with success message for email add', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'carol@example.com' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('carol@example.com');
        expect(replyArg.content).toContain('Added');
        expect(replyArg.content).toContain('email allowlist');
    });

    test('replies with success message for Bluesky add', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'carol.bsky.social' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('carol.bsky.social');
        expect(replyArg.content).toContain('Added');
        expect(replyArg.content).toContain('Bluesky allowlist');
    });

    test('handles add error gracefully', async () => {
        mockEmailAllowlist.addEntry.mockRejectedValue(new Error('Write failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'fail@example.com' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to add');
    });

    test('routes address with @ but no domain dot to bsky (not email)', async () => {
        // 'alice@' has @ at index 5 but lastIndexOf('.') = -1, so 5 < -1 = false → bsky
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'alice@' });
        await handler.handle(asChatInput);

        expect(mockBskyAllowlist.addEntry).toHaveBeenCalledTimes(1);
        expect(mockEmailAllowlist.addEntry).not.toHaveBeenCalled();
    });

    test('handles Bluesky add error gracefully', async () => {
        mockBskyAllowlist.addEntry.mockRejectedValue(new Error('Write failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'fail.bsky.social' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to add');
    });

    test('defers reply before add', async () => {
        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });
});

describe('AllowlistCommandHandler - /allowlist add with resolveHandleToDid', () => {
    let mockEmailAllowlist: ReturnType<typeof createMockEmailAllowlist>;
    let mockBskyAllowlist:  ReturnType<typeof createMockBskyAllowlist>;

    beforeEach(() => {
        mockEmailAllowlist = createMockEmailAllowlist();
        mockBskyAllowlist  = createMockBskyAllowlist();
    });

    test('passes resolved DID to bskyAllowlist.addEntry when callback provided and resolves', async () => {
        const resolveHandleToDid = mock(async (_handle: string): Promise<string | undefined> => 'did:plc:abc123');
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID,
            resolveHandleToDid
        );

        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'alice.bsky.social' });
        await handler.handle(asChatInput);

        expect(resolveHandleToDid).toHaveBeenCalledWith('alice.bsky.social');
        const callArg = mockBskyAllowlist.addEntry.mock.calls[0]?.[0] as { handle: string, did?: string };
        expect(callArg.did).toBe('did:plc:abc123');
    });

    test('adds entry without DID when callback throws', async () => {
        const resolveHandleToDid = mock(async (_handle: string): Promise<string | undefined> => {
            throw new Error('Network error');
        });
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID,
            resolveHandleToDid
        );

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'alice.bsky.social' });
        await handler.handle(asChatInput);

        // Entry must still be added despite DID resolution failure
        expect(mockBskyAllowlist.addEntry).toHaveBeenCalledTimes(1);
        const callArg = mockBskyAllowlist.addEntry.mock.calls[0]?.[0] as { handle: string, did?: string };
        expect(callArg.handle).toBe('alice.bsky.social');
        expect(callArg.did).toBeUndefined();
        // Success reply should still be sent
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Added');
    });

    test('adds entry without DID when no callback provided', async () => {
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID
            // no resolveHandleToDid
        );

        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'alice.bsky.social' });
        await handler.handle(asChatInput);

        expect(mockBskyAllowlist.addEntry).toHaveBeenCalledTimes(1);
        const callArg = mockBskyAllowlist.addEntry.mock.calls[0]?.[0] as { handle: string, did?: string };
        expect(callArg.did).toBeUndefined();
    });

    test('does not call resolveHandleToDid for email address', async () => {
        const resolveHandleToDid = mock(async (_handle: string): Promise<string | undefined> => 'did:plc:xyz');
        const handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID,
            resolveHandleToDid
        );

        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { address: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(resolveHandleToDid).not.toHaveBeenCalled();
        expect(mockEmailAllowlist.addEntry).toHaveBeenCalledTimes(1);
    });
});

describe('AllowlistCommandHandler - /allowlist remove', () => {
    let mockEmailAllowlist: ReturnType<typeof createMockEmailAllowlist>;
    let mockBskyAllowlist:  ReturnType<typeof createMockBskyAllowlist>;
    let handler:            AllowlistCommandHandler;

    beforeEach(() => {
        mockEmailAllowlist = createMockEmailAllowlist();
        mockBskyAllowlist  = createMockBskyAllowlist();
        handler = new AllowlistCommandHandler(
            mockEmailAllowlist as unknown as EmailAllowlist,
            mockBskyAllowlist as BskyAllowlistLike,
            ADMIN_USER_ID
        );
    });

    test('routes email address to emailAllowlist.removeEntry', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'remove', { address: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(mockEmailAllowlist.removeEntry).toHaveBeenCalledTimes(1);
        expect(mockEmailAllowlist.removeEntry).toHaveBeenCalledWith('alice@example.com');
        expect(mockBskyAllowlist.removeEntry).not.toHaveBeenCalled();
    });

    test('routes Bluesky handle to bskyAllowlist.removeEntry', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'remove', { address: 'alice.bsky.social' });
        await handler.handle(asChatInput);

        expect(mockBskyAllowlist.removeEntry).toHaveBeenCalledTimes(1);
        expect(mockBskyAllowlist.removeEntry).toHaveBeenCalledWith('alice.bsky.social');
        expect(mockEmailAllowlist.removeEntry).not.toHaveBeenCalled();
    });

    test('strips leading @ from Bluesky handle on remove', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'remove', { address: '@bob.bsky.social' });
        await handler.handle(asChatInput);

        expect(mockBskyAllowlist.removeEntry).toHaveBeenCalledWith('bob.bsky.social');
    });

    test('replies with success message after email remove', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { address: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('alice@example.com');
        expect(replyArg.content).toContain('Removed');
        expect(replyArg.content).toContain('email allowlist');
    });

    test('replies with success message after Bluesky remove', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { address: 'alice.bsky.social' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('alice.bsky.social');
        expect(replyArg.content).toContain('Removed');
        expect(replyArg.content).toContain('Bluesky allowlist');
    });

    test('handles email remove error gracefully', async () => {
        mockEmailAllowlist.removeEntry.mockRejectedValue(new Error('Delete failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { address: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to remove');
    });

    test('handles Bluesky remove error gracefully', async () => {
        mockBskyAllowlist.removeEntry.mockRejectedValue(new Error('Delete failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { address: 'alice.bsky.social' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to remove');
    });

    test('defers reply before remove', async () => {
        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { address: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });
});
