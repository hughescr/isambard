import { type Mock, describe, test, expect, beforeEach, mock  } from 'bun:test';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { AllowlistCommandHandler, buildAllowlistCommand } from '@/integrations/discord/allowlist-commands';
import { type Contact, type ContactBackend, type ContactId, type PersonAllowlist, createContactId  } from '@/storage';

// Stryker disable next-line StringLiteral: Test admin user ID is a test configuration constant
const ADMIN_USER_ID = '423276934781468692';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockPersonAllowlist(overrides: Partial<{
    isAllowed:       boolean
    isPersonAllowed: boolean
    list:            PersonAllowlist['list']
}> = {}): PersonAllowlist {
    return {
        isAllowed:       mock((_platform: string, _value: string) => overrides.isAllowed ?? false),
        isPersonAllowed: mock((_personId: string) => overrides.isPersonAllowed ?? false),
        addPerson:       mock(async () => {}),
        removePerson:    mock(async () => {}),
        load:            mock(async () => {}),
        list:            overrides.list ?? mock(async () => []),
        refreshPerson:   mock(async () => {}),
    } as unknown as PersonAllowlist;
}

function createMockContactBackend(contact?: Contact): {
    backend:    ContactBackend
    getContact: ReturnType<typeof mock>
} {
    const getContact = mock(async () => contact ?? undefined);
    return {
        backend: { getContact } as unknown as ContactBackend,
        getContact,
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
    const replyMock: Mock<(...args: unknown[]) => Promise<void>>     = mock(async () => {});
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

function makeContact(overrides: Partial<Contact> = {}): Contact {
    return {
        personId:    createContactId('alice'),
        displayName: 'Alice Doe',
        identifiers: [{ platform: 'email', value: 'alice@example.com' }],
        ...overrides,
    } as Contact;
}

// ---------------------------------------------------------------------------
// buildAllowlistCommand tests
// ---------------------------------------------------------------------------

describe('buildAllowlistCommand()', () => {
    test('returns a command with name "allowlist"', () => {
        const cmd  = buildAllowlistCommand();
        const json = cmd.toJSON();
        expect(json.name).toBe('allowlist');
    });

    test('returns a command with description', () => {
        const cmd  = buildAllowlistCommand();
        const json = cmd.toJSON();
        expect(json.description).toBeDefined();
    });

    test('has list, add, and remove subcommands', () => {
        const cmd          = buildAllowlistCommand();
        const json         = cmd.toJSON();
        const subcommands  = json.options ?? [];
        const names        = subcommands.map(s => s.name);
        expect(names).toContain('list');
        expect(names).toContain('add');
        expect(names).toContain('remove');
    });

    test('add subcommand has required person option', () => {
        const cmd    = buildAllowlistCommand();
        const json   = cmd.toJSON();
        const addCmd = (json.options ?? []).find(o => o.name === 'add');
        expect(addCmd).toBeDefined();
        const addOptions: { name: string, required?: boolean }[] = (addCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const personOpt = addOptions.find(o => o.name === 'person');
        expect(personOpt).toBeDefined();
        expect(personOpt?.required).toBe(true);
    });

    test('remove subcommand has required person option', () => {
        const cmd       = buildAllowlistCommand();
        const json      = cmd.toJSON();
        const removeCmd = (json.options ?? []).find(o => o.name === 'remove');
        expect(removeCmd).toBeDefined();
        const removeOptions: { name: string, required?: boolean }[] = (removeCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const personOpt = removeOptions.find(o => o.name === 'person');
        expect(personOpt).toBeDefined();
        expect(personOpt?.required).toBe(true);
    });

    test('sets contexts to Guild, BotDM, and PrivateChannel', () => {
        const cmd  = buildAllowlistCommand();
        const json = cmd.toJSON();
        expect(json.contexts).toEqual([0, 1, 2]);
    });

    test('sets integration types to GuildInstall only', () => {
        const cmd  = buildAllowlistCommand();
        const json = cmd.toJSON();
        expect(json.integration_types).toEqual([0]);
    });
});

// ---------------------------------------------------------------------------
// AllowlistCommandHandler tests
// ---------------------------------------------------------------------------

describe('AllowlistCommandHandler - permission check', () => {
    test('replies with ephemeral denial for non-admin user', async () => {
        const allowlist = createMockPersonAllowlist();
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, reply } = createMockInteraction('999999999999999999', 'list');

        await handler.handle(asChatInput);

        expect(reply).toHaveBeenCalledWith({
            content: 'Only the admin can manage the allowlist.',
            flags:   MessageFlags.Ephemeral,
        });
    });

    test('does not call deferReply for non-admin user', async () => {
        const allowlist = createMockPersonAllowlist();
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, deferReply } = createMockInteraction('non-admin', 'list');

        await handler.handle(asChatInput);

        expect(deferReply).not.toHaveBeenCalled();
    });

    test('calls deferReply with Ephemeral flag for admin user', async () => {
        const allowlist = createMockPersonAllowlist({ list: mock(async () => []) });
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });
});

describe('AllowlistCommandHandler - list', () => {
    test('replies with "empty" when no entries', async () => {
        const allowlist = createMockPersonAllowlist({ list: mock(async () => []) });
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('empty');
    });

    test('shows contact displayName for each entry', async () => {
        const contact   = makeContact({ displayName: 'Alice Doe', identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }] });
        const personId  = contact.personId;
        const allowlist = createMockPersonAllowlist({
            list: mock(async () => [{ personId, addedAt: '2024-01-01T00:00:00Z', addedBy: 'discord-command' }]),
        });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Alice Doe');
    });

    test('shows entry notes and contact notes when both are present', async () => {
        const contact   = makeContact({ displayName: 'Alice Doe', identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }], notes: 'Friend from college' });
        const personId  = contact.personId;
        const allowlist = createMockPersonAllowlist({
            list: mock(async () => [{ personId, addedAt: '2024-01-01T00:00:00Z', addedBy: 'discord-command', notes: 'Migrated from email allowlist' }]),
        });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Allowlist: Migrated from email allowlist');
        expect(arg.content).toContain('Contact: Friend from college');
    });

    test('shows only entry notes when contact has no notes', async () => {
        const contact   = makeContact({ displayName: 'Alice Doe', identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }] });
        const personId  = contact.personId;
        const allowlist = createMockPersonAllowlist({
            list: mock(async () => [{ personId, addedAt: '2024-01-01T00:00:00Z', addedBy: 'discord-command', notes: 'Trusted partner' }]),
        });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Allowlist: Trusted partner');
        expect(arg.content).not.toContain('Contact:');
    });

    test('does not show Allowlist: line when entry has no notes', async () => {
        const contact   = makeContact({ displayName: 'Alice Doe', identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }] });
        const personId  = contact.personId;
        // Entry has no notes field
        const allowlist = createMockPersonAllowlist({
            list: mock(async () => [{ personId, addedAt: '2024-01-01T00:00:00Z', addedBy: 'discord-command' }]),
        });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).not.toContain('Allowlist:');
    });

    test('output starts with bullet character for found contact', async () => {
        const contact   = makeContact({ displayName: 'Alice Doe', identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }] });
        const personId  = contact.personId;
        const allowlist = createMockPersonAllowlist({
            list: mock(async () => [{ personId, addedAt: '2024-01-01T00:00:00Z', addedBy: 'discord-command' }]),
        });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toMatch(/^•/u);
    });

    test('separates parts (name, allowlist notes, contact notes) with newlines', async () => {
        const contact   = makeContact({ displayName: 'Alice Doe', identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }], notes: 'Contact note' });
        const personId  = contact.personId;
        const allowlist = createMockPersonAllowlist({
            list: mock(async () => [{ personId, addedAt: '2024-01-01T00:00:00Z', addedBy: 'discord-command', notes: 'Allowlist note' }]),
        });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        // All three parts should appear separated by newlines (not concatenated)
        expect(arg.content).toContain('Alice Doe');
        expect(arg.content).toContain('\n  Allowlist: Allowlist note');
        expect(arg.content).toContain('\n  Contact: Contact note');
    });

    test('separates multiple entries with newlines', async () => {
        const aliceContact = makeContact({ displayName: 'Alice Doe', identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }] });
        const bobContact   = makeContact({ personId: createContactId('bob'), displayName: 'Bob Smith', identifiers: [{ platform: 'email' as const, value: 'bob@example.com' }] });

        const aliceId = aliceContact.personId;
        const bobId   = bobContact.personId;

        const allowlist = createMockPersonAllowlist({
            list: mock(async () => [
                { personId: aliceId, addedAt: '2024-01-01T00:00:00Z', addedBy: 'discord-command' },
                { personId: bobId,   addedAt: '2024-01-02T00:00:00Z', addedBy: 'discord-command' },
            ]),
        });

        // Return different contact based on personId
        const getContact = mock(async (id: string) => {
            if(id === aliceId) {
                return aliceContact;
            }
            return bobContact;
        });
        const backend = { getContact } as unknown as import('@/storage').ContactBackend;

        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        // Both entries present separated by newline, not concatenated
        expect(arg.content).toContain('Alice Doe');
        expect(arg.content).toContain('Bob Smith');
        // They should be separated by a newline between them
        const aliceIdx = arg.content.indexOf('Alice Doe');
        const bobIdx   = arg.content.indexOf('Bob Smith');
        const between  = arg.content.slice(aliceIdx, bobIdx);
        expect(between).toContain('\n');
    });

    test('shows "(contact not found)" for orphaned personId', async () => {
        const personId  = createContactId('orphan');
        const allowlist = createMockPersonAllowlist({
            list: mock(async () => [{ personId, addedAt: '2024-01-01T00:00:00Z', addedBy: 'discord-command' }]),
        });
        const { backend } = createMockContactBackend(undefined); // contact not found
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('contact not found');
    });

    test('replies with error message when list() throws', async () => {
        const allowlist = createMockPersonAllowlist({
            list: mock(async () => { throw new Error('DynamoDB failure'); }),
        });
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Failed to list');
    });
});

describe('AllowlistCommandHandler - add', () => {
    test('reports invalid format when personId is not valid', async () => {
        const allowlist = createMockPersonAllowlist();
        const { backend } = createMockContactBackend(undefined);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { person: 'INVALID ID!!!' });

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Invalid person ID format');
        expect(allowlist.addPerson).not.toHaveBeenCalled();
    });

    test('reports contact not found when contactBackend returns undefined', async () => {
        const allowlist = createMockPersonAllowlist();
        const { backend } = createMockContactBackend(undefined);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { person: 'alice' });

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('not found');
        expect(allowlist.addPerson).not.toHaveBeenCalled();
    });

    test('reports already allowlisted when isPersonAllowed returns true', async () => {
        const contact   = makeContact();
        const allowlist = createMockPersonAllowlist({ isPersonAllowed: true });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { person: 'alice' });

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('already on the allowlist');
        expect(allowlist.addPerson).not.toHaveBeenCalled();
    });

    test('calls addPerson and confirms when contact exists and not already allowlisted', async () => {
        const contact   = makeContact({ displayName: 'Alice Doe', identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }] });
        const allowlist = createMockPersonAllowlist({ isPersonAllowed: false });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { person: 'alice' });

        await handler.handle(asChatInput);

        expect(allowlist.addPerson).toHaveBeenCalledTimes(1);
        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Alice Doe');
        expect(arg.content).toContain('allowlist');
    });

    test('calls addPerson with addedBy: discord-command', async () => {
        const contact   = makeContact();
        const allowlist = createMockPersonAllowlist({ isPersonAllowed: false });
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', { person: 'alice' });

        await handler.handle(asChatInput);

        const addPersonCall = (allowlist.addPerson as ReturnType<typeof mock>).mock.calls[0] as [string, { addedBy: string }];
        expect(addPersonCall[1].addedBy).toBe('discord-command');
    });

    test('replies with error message when addPerson throws', async () => {
        const contact   = makeContact();
        const allowlist = createMockPersonAllowlist({ isPersonAllowed: false });
        (allowlist.addPerson as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB failure'));
        const { backend } = createMockContactBackend(contact);
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { person: 'alice' });

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Failed to add');
    });
});

describe('AllowlistCommandHandler - remove', () => {
    beforeEach(() => {});

    test('reports invalid format when personId is not valid', async () => {
        const allowlist = createMockPersonAllowlist();
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { person: 'INVALID ID!!!' });

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Invalid person ID format');
        expect(allowlist.removePerson).not.toHaveBeenCalled();
    });

    test('reports not on allowlist when isPersonAllowed returns false', async () => {
        const allowlist = createMockPersonAllowlist({ isPersonAllowed: false });
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { person: 'alice' });

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('not on the allowlist');
        expect(allowlist.removePerson).not.toHaveBeenCalled();
    });

    test('calls removePerson and confirms when person is on allowlist', async () => {
        const allowlist = createMockPersonAllowlist({ isPersonAllowed: true });
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { person: 'alice' });

        await handler.handle(asChatInput);

        expect(allowlist.removePerson).toHaveBeenCalledTimes(1);
        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Removed');
    });

    test('calls removePerson with the contactId derived from personIdStr', async () => {
        const allowlist = createMockPersonAllowlist({ isPersonAllowed: true });
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'remove', { person: 'alice' });

        await handler.handle(asChatInput);

        const removePersonCall = (allowlist.removePerson as ReturnType<typeof mock>).mock.calls[0] as [ContactId];
        expect(removePersonCall[0]).toBe(createContactId('alice'));
    });

    test('replies with error message when removePerson throws', async () => {
        const allowlist = createMockPersonAllowlist({ isPersonAllowed: true });
        (allowlist.removePerson as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB failure'));
        const { backend } = createMockContactBackend();
        const handler = new AllowlistCommandHandler(allowlist, backend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'remove', { person: 'alice' });

        await handler.handle(asChatInput);

        const arg = editReply.mock.calls[0]?.[0] as { content: string };
        expect(arg.content).toContain('Failed to remove');
    });
});
