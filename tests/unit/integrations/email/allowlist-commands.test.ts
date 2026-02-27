import { type Mock, describe, test, expect, beforeEach, mock  } from 'bun:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import find from 'lodash/find';
import map from 'lodash/map';
import split from 'lodash/split';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import { AllowlistCommandHandler, buildAllowlistCommand } from '@/integrations/email/allowlist-commands';
import type { AllowlistEntry } from '@/integrations/email/types';

// Admin Discord user ID used in tests
// Stryker disable next-line StringLiteral: Test admin user ID is a test configuration constant
const ADMIN_USER_ID = '423276934781468692';

// Minimal mock for EmailAllowlist
function createMockAllowlist(): {
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
        expect(json.description).toBe('Manage the email allowlist');
    });

    test('has list, add, and remove subcommands', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        const subcommands = json.options ?? [];
        const names = map(subcommands, 'name');
        expect(names).toContain('list');
        expect(names).toContain('add');
        expect(names).toContain('remove');
    });

    test('add subcommand has required email option', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        const addCmd = find(json.options ?? [], { name: 'add' });
        expect(addCmd).toBeDefined();
        const addOptions: { name: string, required?: boolean }[] = (addCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const emailOpt = find(addOptions, { name: 'email' });
        expect(emailOpt).toBeDefined();
        expect(emailOpt?.required).toBe(true);
    });

    test('add subcommand has optional name and notes options', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        const addCmd = find(json.options ?? [], { name: 'add' });
        const addOptions: { name: string, required?: boolean }[] = (addCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const nameOpt = find(addOptions, { name: 'name' });
        const notesOpt = find(addOptions, { name: 'notes' });
        expect(nameOpt).toBeDefined();
        expect(nameOpt?.required).toBeFalsy();
        expect(notesOpt).toBeDefined();
        expect(notesOpt?.required).toBeFalsy();
    });

    test('remove subcommand has required email option', () => {
        const cmd = buildAllowlistCommand();
        const json = cmd.toJSON();
        const removeCmd = find(json.options ?? [], { name: 'remove' });
        expect(removeCmd).toBeDefined();
        const removeOptions: { name: string, required?: boolean }[] = (removeCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const emailOpt = find(removeOptions, { name: 'email' });
        expect(emailOpt).toBeDefined();
        expect(emailOpt?.required).toBe(true);
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
        const mockAllowlist = createMockAllowlist();
        const handler = new AllowlistCommandHandler(mockAllowlist as unknown as EmailAllowlist, ADMIN_USER_ID);
        const { asChatInput, reply } = createMockInteraction('999999999999999999', 'list');

        await handler.handle(asChatInput);

        expect(reply).toHaveBeenCalledWith({
            content:   'Only the admin can manage the allowlist.',
            ephemeral: true,
        });
        expect(mockAllowlist.list).not.toHaveBeenCalled();
    });

    test('does not call deferReply for non-admin user', async () => {
        const mockAllowlist = createMockAllowlist();
        const handler = new AllowlistCommandHandler(mockAllowlist as unknown as EmailAllowlist, ADMIN_USER_ID);
        const { asChatInput, deferReply } = createMockInteraction('000000000000000000', 'list');

        await handler.handle(asChatInput);

        expect(deferReply).not.toHaveBeenCalled();
    });

    test('allows configured adminDiscordUserId to proceed', async () => {
        const mockAllowlist = createMockAllowlist();
        const handler = new AllowlistCommandHandler(mockAllowlist as unknown as EmailAllowlist, ADMIN_USER_ID);
        const { asChatInput, reply, deferReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        expect(reply).not.toHaveBeenCalled();
        expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    });

    test('allows custom adminDiscordUserId and rejects a different user', async () => {
        const customUserId = '111222333444555666';
        const mockAllowlist = createMockAllowlist();
        const handler = new AllowlistCommandHandler(mockAllowlist as unknown as EmailAllowlist, customUserId);

        // Custom user ID should be allowed
        const { asChatInput: customUserInteraction, reply: customReply, deferReply: customDeferReply }
            = createMockInteraction(customUserId, 'list');
        await handler.handle(customUserInteraction);
        expect(customReply).not.toHaveBeenCalled();
        expect(customDeferReply).toHaveBeenCalledWith({ ephemeral: true });
    });

    test('rejects a different user when custom adminDiscordUserId is configured', async () => {
        const customUserId = '111222333444555666';
        const mockAllowlist = createMockAllowlist();
        const handler = new AllowlistCommandHandler(mockAllowlist as unknown as EmailAllowlist, customUserId);

        // ADMIN_USER_ID should be rejected when a different custom ID is configured
        const { asChatInput: otherInteraction, reply: otherReply }
            = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(otherInteraction);
        expect(otherReply).toHaveBeenCalledWith({
            content:   'Only the admin can manage the allowlist.',
            ephemeral: true,
        });
        expect(mockAllowlist.list).not.toHaveBeenCalled();
    });
});

describe('AllowlistCommandHandler - /allowlist list', () => {
    let mockAllowlist: ReturnType<typeof createMockAllowlist>;
    let handler: AllowlistCommandHandler;

    beforeEach(() => {
        mockAllowlist = createMockAllowlist();
        handler = new AllowlistCommandHandler(mockAllowlist as unknown as EmailAllowlist, ADMIN_USER_ID);
    });

    test('calls allowlist.list() and replies with entries', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'alice@example.com', name: 'Alice', notes: 'Test user', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
            { email: 'bob@example.com',   addedAt: '2026-01-02T00:00:00Z', addedBy: 'admin' },
        ];
        mockAllowlist.list.mockResolvedValue(entries);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        expect(mockAllowlist.list).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('alice@example.com');
        expect(replyArg.content).toContain('bob@example.com');
    });

    test('formats entry with name and notes as pipe-separated parts', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'alice@example.com', name: 'Alice', notes: 'Test user', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
        ];
        mockAllowlist.list.mockResolvedValue(entries);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        // Should have exact format with pipe separators
        expect(replyArg.content).toContain('**alice@example.com**');
        expect(replyArg.content).toContain('Name: Alice');
        expect(replyArg.content).toContain('Notes: Test user');
        expect(replyArg.content).toContain('Added: 2026-01-01T00:00:00Z');
        expect(replyArg.content).toContain('**alice@example.com** | Name: Alice | Notes: Test user | Added: 2026-01-01T00:00:00Z');
    });

    test('formats entry without name when name is absent', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'bob@example.com', addedAt: '2026-01-02T00:00:00Z', addedBy: 'admin' },
        ];
        mockAllowlist.list.mockResolvedValue(entries);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).not.toContain('Name:');
        expect(replyArg.content).toContain('**bob@example.com** | Added: 2026-01-02T00:00:00Z');
    });

    test('formats entry without notes when notes is absent', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'carol@example.com', name: 'Carol', addedAt: '2026-01-03T00:00:00Z', addedBy: 'admin' },
        ];
        mockAllowlist.list.mockResolvedValue(entries);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).not.toContain('Notes:');
        expect(replyArg.content).toContain('**carol@example.com** | Name: Carol | Added: 2026-01-03T00:00:00Z');
    });

    test('separates multiple entries with newlines', async () => {
        const entries: AllowlistEntry[] = [
            { email: 'alice@example.com', addedAt: '2026-01-01T00:00:00Z', addedBy: 'admin' },
            { email: 'bob@example.com',   addedAt: '2026-01-02T00:00:00Z', addedBy: 'admin' },
        ];
        mockAllowlist.list.mockResolvedValue(entries);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        const content = replyArg.content ?? '';
        // Two entries should be separated by newline
        const lines = split(content, '\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('alice@example.com');
        expect(lines[1]).toContain('bob@example.com');
    });

    test('replies with empty message when allowlist is empty', async () => {
        mockAllowlist.list.mockResolvedValue([]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No entries in allowlist');
    });

    test('defers reply before fetching list', async () => {
        mockAllowlist.list.mockResolvedValue([]);

        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    });

    test('handles list error gracefully', async () => {
        mockAllowlist.list.mockRejectedValue(new Error('DynamoDB error'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to list allowlist entries');
    });
});

describe('AllowlistCommandHandler - /allowlist add', () => {
    let mockAllowlist: ReturnType<typeof createMockAllowlist>;
    let handler: AllowlistCommandHandler;

    beforeEach(() => {
        mockAllowlist = createMockAllowlist();
        handler = new AllowlistCommandHandler(mockAllowlist as unknown as EmailAllowlist, ADMIN_USER_ID);
    });

    test('calls addEntry with email only', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { email: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(mockAllowlist.addEntry).toHaveBeenCalledTimes(1);
        const callArg = mockAllowlist.addEntry.mock.calls[0]?.[0] as AllowlistEntry;
        expect(callArg.email).toBe('alice@example.com');
        expect(callArg.addedBy).toBe('discord-command');
        expect(callArg.name).toBeUndefined();
        expect(callArg.notes).toBeUndefined();
        expect(callArg.addedAt).toBeDefined();
    });

    test('calls addEntry with email, name, and notes', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            email: 'bob@example.com',
            name:  'Bob',
            notes: 'Important contact',
        });
        await handler.handle(asChatInput);

        const callArg = mockAllowlist.addEntry.mock.calls[0]?.[0] as AllowlistEntry;
        expect(callArg.email).toBe('bob@example.com');
        expect(callArg.name).toBe('Bob');
        expect(callArg.notes).toBe('Important contact');
        expect(callArg.addedBy).toBe('discord-command');
    });

    test('replies with success message after add', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { email: 'carol@example.com' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('carol@example.com');
        expect(replyArg.content).toContain('Added');
    });

    test('handles add error gracefully', async () => {
        mockAllowlist.addEntry.mockRejectedValue(new Error('Write failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { email: 'fail@example.com' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to add');
    });

    test('defers reply before add', async () => {
        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'add', { email: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    });
});

describe('AllowlistCommandHandler - /allowlist remove', () => {
    let mockAllowlist: ReturnType<typeof createMockAllowlist>;
    let handler: AllowlistCommandHandler;

    beforeEach(() => {
        mockAllowlist = createMockAllowlist();
        handler = new AllowlistCommandHandler(mockAllowlist as unknown as EmailAllowlist, ADMIN_USER_ID);
    });

    test('calls removeEntry with the email', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'remove', { email: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(mockAllowlist.removeEntry).toHaveBeenCalledTimes(1);
        expect(mockAllowlist.removeEntry).toHaveBeenCalledWith('alice@example.com');
    });

    test('replies with success message after remove', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { email: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('alice@example.com');
        expect(replyArg.content).toContain('Removed');
    });

    test('handles remove error gracefully', async () => {
        mockAllowlist.removeEntry.mockRejectedValue(new Error('Delete failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { email: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to remove');
    });

    test('defers reply before remove', async () => {
        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { email: 'alice@example.com' });
        await handler.handle(asChatInput);

        expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    });
});
