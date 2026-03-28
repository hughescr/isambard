import { describe, test, expect, beforeEach, mock, type Mock } from 'bun:test';
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import {
    buildContactCommand,
    buildContactApprovalEmbed,
    ContactCommandHandler,
    ContactApprovalHandler,
    generatePersonId,
    type ContactApprovalRequest
} from '../../../../src/integrations/discord/contact-commands';
import { mockLogger } from '../../../setup';
import { ContactNotFoundError, ContactLastIdentifierError } from '@/errors';
import type { Contact, ContactBackend } from '@/storage';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// Stryker disable next-line StringLiteral: Test admin user ID is a test configuration constant
const ADMIN_USER_ID = '423276934781468692';

const SAMPLE_CONTACT: Contact = {
    personId:    'alice-wonderland' as Contact['personId'],
    displayName: 'Alice Wonderland',
    identifiers: [
        { platform: 'name',  value: 'Alice Wonderland' },
        { platform: 'email', value: 'alice@example.com' },
    ],
    notes:     'Test contact',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockBackend(): {
    getContact:        Mock<(...args: unknown[]) => Promise<Contact | undefined>>
    putContact:        Mock<(...args: unknown[]) => Promise<void>>
    deleteContact:     Mock<(...args: unknown[]) => Promise<void>>
    addIdentifier:     Mock<(...args: unknown[]) => Promise<void>>
    removeIdentifier:  Mock<(...args: unknown[]) => Promise<void>>
    listContacts:      Mock<(...args: unknown[]) => Promise<Contact[]>>
    fuzzyLookup:       Mock<(...args: unknown[]) => Promise<Contact[]>>
    resolveIdentifier: Mock<(...args: unknown[]) => Promise<Contact[]>>
} {
    return {
        getContact:        mock(async (): Promise<Contact | undefined> => undefined),
        putContact:        mock(async (): Promise<void> => {}),
        deleteContact:     mock(async (): Promise<void> => {}),
        addIdentifier:     mock(async (): Promise<void> => {}),
        removeIdentifier:  mock(async (): Promise<void> => {}),
        listContacts:      mock(async (): Promise<Contact[]> => []),
        fuzzyLookup:       mock(async (): Promise<Contact[]> => []),
        resolveIdentifier: mock(async (): Promise<Contact[]> => []),
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

function makeButtonInteraction(customId: string): {
    interaction: ButtonInteraction
    deferUpdate: Mock<(...args: unknown[]) => Promise<void>>
    editReply:   Mock<(...args: unknown[]) => Promise<void>>
} {
    const deferUpdate: Mock<(...args: unknown[]) => Promise<void>> = mock(async () => {});
    const editReply: Mock<(...args: unknown[]) => Promise<void>>   = mock(async () => {});
    const interaction = {
        customId,
        deferUpdate,
        editReply,
    } as unknown as ButtonInteraction;
    return { interaction, deferUpdate, editReply };
}

// ---------------------------------------------------------------------------
// generatePersonId tests
// ---------------------------------------------------------------------------

describe('generatePersonId()', () => {
    test('lowercases and replaces spaces with hyphens', () => {
        expect(generatePersonId('Alice Wonderland')).toBe('alice-wonderland');
    });

    test('handles multiple spaces', () => {
        expect(generatePersonId('John   Doe')).toBe('john-doe');
    });

    test('strips leading and trailing hyphens', () => {
        expect(generatePersonId(' Craig ')).toBe('craig');
    });

    test('replaces special characters with hyphens', () => {
        expect(generatePersonId('O\'Brien')).toBe('o-brien');
    });

    test('collapses consecutive non-alphanumeric runs into single hyphen', () => {
        expect(generatePersonId('Alice & Bob')).toBe('alice-bob');
    });

    test('handles already-lowercase single word', () => {
        expect(generatePersonId('alice')).toBe('alice');
    });
});

// ---------------------------------------------------------------------------
// buildContactCommand tests
// ---------------------------------------------------------------------------

describe('buildContactCommand()', () => {
    test('returns a command with name "contact"', () => {
        const cmd  = buildContactCommand();
        const json = cmd.toJSON();
        expect(json.name).toBe('contact');
    });

    test('returns a command with correct description', () => {
        const cmd  = buildContactCommand();
        const json = cmd.toJSON();
        expect(json.description).toBe('Manage the contacts address book');
    });

    test('has add, link, unlink, list, and show subcommands', () => {
        const cmd          = buildContactCommand();
        const json         = cmd.toJSON();
        const subcommands  = json.options ?? [];
        const names        = subcommands.map((s: { name: string }) => s.name);
        expect(names).toContain('add');
        expect(names).toContain('link');
        expect(names).toContain('unlink');
        expect(names).toContain('list');
        expect(names).toContain('show');
    });

    test('add subcommand has required name option', () => {
        const cmd    = buildContactCommand();
        const json   = cmd.toJSON();
        const addCmd = (json.options ?? []).find((o: { name: string }) => o.name === 'add');
        expect(addCmd).toBeDefined();
        const addOptions: { name: string, required?: boolean }[] = (addCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const nameOpt = addOptions.find(o => o.name === 'name');
        expect(nameOpt).toBeDefined();
        expect(nameOpt?.required).toBe(true);
    });

    test('add subcommand has optional discord, email, bsky, nickname, notes options', () => {
        const cmd    = buildContactCommand();
        const json   = cmd.toJSON();
        const addCmd = (json.options ?? []).find((o: { name: string }) => o.name === 'add');
        const addOptions: { name: string, required?: boolean }[] = (addCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        for(const optName of ['discord', 'email', 'bsky', 'nickname', 'notes']) {
            const opt = addOptions.find(o => o.name === optName);
            expect(opt).toBeDefined();
            expect(opt?.required).toBeFalsy();
        }
    });

    test('link subcommand has required person, platform, id options', () => {
        const cmd     = buildContactCommand();
        const json    = cmd.toJSON();
        const linkCmd = (json.options ?? []).find((o: { name: string }) => o.name === 'link');
        const linkOptions: { name: string, required?: boolean }[] = (linkCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        for(const optName of ['person', 'platform', 'id']) {
            const opt = linkOptions.find(o => o.name === optName);
            expect(opt).toBeDefined();
            expect(opt?.required).toBe(true);
        }
    });

    test('show subcommand has required person option', () => {
        const cmd     = buildContactCommand();
        const json    = cmd.toJSON();
        const showCmd = (json.options ?? []).find((o: { name: string }) => o.name === 'show');
        const showOptions: { name: string, required?: boolean }[] = (showCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const personOpt = showOptions.find(o => o.name === 'person');
        expect(personOpt).toBeDefined();
        expect(personOpt?.required).toBe(true);
    });

    test('sets contexts to Guild, BotDM, and PrivateChannel', () => {
        const cmd  = buildContactCommand();
        const json = cmd.toJSON();
        expect(json.contexts).toEqual([0, 1, 2]);
    });

    test('sets integration types to GuildInstall only', () => {
        const cmd  = buildContactCommand();
        const json = cmd.toJSON();
        expect(json.integration_types).toEqual([0]);
    });
});

// ---------------------------------------------------------------------------
// buildContactApprovalEmbed tests
// ---------------------------------------------------------------------------

describe('buildContactApprovalEmbed()', () => {
    test('returns embed and actionRow', () => {
        const request: ContactApprovalRequest = {
            action:         'create',
            displayName:    'Bob Smith',
            addIdentifiers: [{ platform: 'email', value: 'bob@example.com' }],
        };
        const { embed, actionRow } = buildContactApprovalEmbed(request);
        expect(embed).toBeDefined();
        expect(actionRow).toBeDefined();
    });

    test('create request has "Contact Create Request" title', () => {
        const request: ContactApprovalRequest = { action: 'create', displayName: 'Bob' };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        expect(json.title).toBe('Contact Create Request');
    });

    test('update request has "Contact Update Request" title', () => {
        const request: ContactApprovalRequest = { action: 'update', personId: 'bob-smith' };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        expect(json.title).toBe('Contact Update Request');
    });

    test('includes displayName field when present', () => {
        const request: ContactApprovalRequest = { action: 'create', displayName: 'Charlie' };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const field = json.fields?.find((f: { name: string }) => f.name === 'Display Name');
        expect(field).toBeDefined();
        expect(field?.value).toBe('Charlie');
    });

    test('includes personId field when present', () => {
        const request: ContactApprovalRequest = { action: 'update', personId: 'alice-wonderland' };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const field = json.fields?.find((f: { name: string }) => f.name === 'Person ID');
        expect(field).toBeDefined();
        expect(field?.value).toBe('alice-wonderland');
    });

    test('includes Add Identifiers field when addIdentifiers present', () => {
        const request: ContactApprovalRequest = {
            action:         'create',
            displayName:    'Dave',
            addIdentifiers: [{ platform: 'email', value: 'dave@example.com' }],
        };
        const { embed } = buildContactApprovalEmbed(request);
        const json      = embed.toJSON();
        const field     = json.fields?.find((f: { name: string }) => f.name === 'Add Identifiers');
        expect(field).toBeDefined();
        expect(field?.value).toContain('email: dave@example.com');
    });

    test('includes Remove Identifiers field when removeIdentifiers present', () => {
        const request: ContactApprovalRequest = {
            action:            'update',
            personId:          'dave-smith',
            removeIdentifiers: [{ platform: 'email', value: 'dave@example.com' }],
        };
        const { embed } = buildContactApprovalEmbed(request);
        const json      = embed.toJSON();
        const field     = json.fields?.find((f: { name: string }) => f.name === 'Remove Identifiers');
        expect(field).toBeDefined();
        expect(field?.value).toContain('email: dave@example.com');
    });

    test('shows both Add Identifiers and Remove Identifiers when both present', () => {
        const request: ContactApprovalRequest = {
            action:            'update',
            personId:          'dave-smith',
            addIdentifiers:    [{ platform: 'discord', value: 'dave#5678' }],
            removeIdentifiers: [{ platform: 'email', value: 'dave@old.com' }],
        };
        const { embed } = buildContactApprovalEmbed(request);
        const json      = embed.toJSON();
        const addField    = json.fields?.find((f: { name: string }) => f.name === 'Add Identifiers');
        const removeField = json.fields?.find((f: { name: string }) => f.name === 'Remove Identifiers');
        expect(addField).toBeDefined();
        expect(addField?.value).toContain('discord: dave#5678');
        expect(removeField).toBeDefined();
        expect(removeField?.value).toContain('email: dave@old.com');
    });

    test('includes notes field when present', () => {
        const request: ContactApprovalRequest = { action: 'create', displayName: 'Eve', notes: 'Test note' };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const field = json.fields?.find((f: { name: string }) => f.name === 'Notes');
        expect(field).toBeDefined();
        expect(field?.value).toBe('Test note');
    });

    test('omits optional fields when not present', () => {
        const request: ContactApprovalRequest = { action: 'create' };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const fieldNames = (json.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).not.toContain('Display Name');
        expect(fieldNames).not.toContain('Person ID');
        expect(fieldNames).not.toContain('Add Identifiers');
        expect(fieldNames).not.toContain('Remove Identifiers');
        expect(fieldNames).not.toContain('Notes');
    });

    test('actionRow has approve and reject buttons', () => {
        const request: ContactApprovalRequest = { action: 'create', displayName: 'Frank' };
        const { actionRow }                    = buildContactApprovalEmbed(request);
        const json                             = actionRow.toJSON();
        // ActionRow has components (buttons)
        expect(json.components.length).toBe(2);
        const ids = json.components.map(c => (c as unknown as { custom_id?: string }).custom_id ?? '');
        expect(ids.some((id: string) => id.startsWith('contact-approve:'))).toBe(true);
        expect(ids.some((id: string) => id.startsWith('contact-reject:'))).toBe(true);
    });

    test('omits Add Identifiers field when addIdentifiers is empty array', () => {
        const request: ContactApprovalRequest = { action: 'create', displayName: 'Henry', addIdentifiers: [] };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const fieldNames = (json.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).not.toContain('Add Identifiers');
    });

    test('omits Remove Identifiers field when removeIdentifiers is empty array', () => {
        const request: ContactApprovalRequest = { action: 'update', personId: 'henry-smith', removeIdentifiers: [] };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const fieldNames = (json.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).not.toContain('Remove Identifiers');
    });

    test('Add Identifiers field uses newline separator for multiple identifiers', () => {
        const request: ContactApprovalRequest = {
            action:         'create',
            displayName:    'Ivy',
            addIdentifiers: [
                { platform: 'email', value: 'ivy@example.com' },
                { platform: 'bsky',  value: 'ivy.bsky.social' },
            ],
        };
        const { embed } = buildContactApprovalEmbed(request);
        const json      = embed.toJSON();
        const field     = json.fields?.find((f: { name: string }) => f.name === 'Add Identifiers');
        expect(field?.value).toContain('email: ivy@example.com');
        expect(field?.value).toContain('bsky: ivy.bsky.social');
        expect(field?.value).toContain('\n');
    });

    test('each call generates unique UUIDs in button customIds', () => {
        const request: ContactApprovalRequest = { action: 'create', displayName: 'Grace' };
        const result1 = buildContactApprovalEmbed(request);
        const result2 = buildContactApprovalEmbed(request);
        const getId   = (ar: ReturnType<typeof buildContactApprovalEmbed>['actionRow']) =>
            (ar.toJSON().components[0] as unknown as { custom_id?: string }).custom_id ?? '';
        expect(getId(result1.actionRow)).not.toBe(getId(result2.actionRow));
    });
});

// ---------------------------------------------------------------------------
// ContactCommandHandler — permission check
// ---------------------------------------------------------------------------

describe('ContactCommandHandler - permission check', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactCommandHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
    });

    test('replies with ephemeral denial for non-admin user', async () => {
        const { asChatInput, reply } = createMockInteraction('999999999999999999', 'list');

        await handler.handle(asChatInput);

        expect(reply).toHaveBeenCalledWith({
            content: 'Only the admin can manage contacts.',
            flags:   MessageFlags.Ephemeral,
        });
        expect(backend.listContacts).not.toHaveBeenCalled();
    });

    test('does not call deferReply for non-admin user', async () => {
        const { asChatInput, deferReply } = createMockInteraction('000000000000000000', 'list');

        await handler.handle(asChatInput);

        expect(deferReply).not.toHaveBeenCalled();
    });

    test('allows admin user to proceed to subcommand', async () => {
        backend.listContacts.mockImplementation(async () => []);
        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });
});

// ---------------------------------------------------------------------------
// ContactCommandHandler — add subcommand
// ---------------------------------------------------------------------------

describe('ContactCommandHandler - add subcommand', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactCommandHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
    });

    test('creates contact with display name and name identifier', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', {
            name: 'Alice Wonderland',
        });

        await handler.handle(asChatInput);

        expect(backend.putContact).toHaveBeenCalledTimes(1);
        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.displayName).toBe('Alice Wonderland');
        expect(String(contact.personId)).toBe('alice-wonderland');
        expect(contact.identifiers.some(id => id.platform === 'name' && id.value === 'Alice Wonderland')).toBe(true);
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('alice-wonderland') as unknown as string })
        );
    });

    test('includes discord identifier when discord option provided', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            name:    'Alice',
            discord: 'alice#1234',
        });

        await handler.handle(asChatInput);

        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.identifiers.some(id => id.platform === 'discord' && id.value === 'alice#1234')).toBe(true);
    });

    test('includes email identifier when email option provided', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            name:  'Alice',
            email: 'alice@example.com',
        });

        await handler.handle(asChatInput);

        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.identifiers.some(id => id.platform === 'email' && id.value === 'alice@example.com')).toBe(true);
    });

    test('includes bsky identifier when bsky option provided', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            name: 'Alice',
            bsky: 'alice.bsky.social',
        });

        await handler.handle(asChatInput);

        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.identifiers.some(id => id.platform === 'bsky' && id.value === 'alice.bsky.social')).toBe(true);
    });

    test('includes nickname identifier when nickname option provided', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            name:     'Alice Wonderland',
            nickname: 'Ali',
        });

        await handler.handle(asChatInput);

        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.identifiers.some(id => id.platform === 'nickname' && id.value === 'Ali')).toBe(true);
    });

    test('includes notes when notes option provided', async () => {
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            name:  'Alice',
            notes: 'A test contact',
        });

        await handler.handle(asChatInput);

        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.notes).toBe('A test contact');
    });

    test('replies with error message when putContact throws', async () => {
        backend.putContact.mockImplementation(async () => {
            throw new Error('DynamoDB error');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { name: 'Fail Case' });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Failed to create contact') as unknown as string })
        );
    });

    test('replies with error when display name produces empty personId (all special characters)', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { name: '!!!' });

        await handler.handle(asChatInput);

        expect(backend.putContact).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Cannot generate a valid ID') as unknown as string })
        );
    });

    test('appends -2 suffix when base personId is already taken', async () => {
        backend.getContact
            .mockResolvedValueOnce(SAMPLE_CONTACT)  // 'alice' is taken
            .mockResolvedValueOnce(undefined);       // 'alice-2' is free
        backend.putContact.mockResolvedValue(undefined);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { name: 'Alice' });

        await handler.handle(asChatInput);

        expect(backend.putContact).toHaveBeenCalledTimes(1);
        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(String(contact.personId)).toBe('alice-2');
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('alice-2') as unknown as string })
        );
    });

    test('appends -3 suffix when base and -2 personIds are both taken', async () => {
        backend.getContact
            .mockResolvedValueOnce(SAMPLE_CONTACT)  // 'alice' is taken
            .mockResolvedValueOnce(SAMPLE_CONTACT)  // 'alice-2' is taken
            .mockResolvedValueOnce(undefined);       // 'alice-3' is free
        backend.putContact.mockResolvedValue(undefined);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { name: 'Alice' });

        await handler.handle(asChatInput);

        expect(backend.putContact).toHaveBeenCalledTimes(1);
        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(String(contact.personId)).toBe('alice-3');
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('alice-3') as unknown as string })
        );
    });
});

// ---------------------------------------------------------------------------
// ContactCommandHandler — link subcommand
// ---------------------------------------------------------------------------

describe('ContactCommandHandler - link subcommand', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactCommandHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        mockLogger.error.mockClear();
    });

    test('calls addIdentifier with correct arguments', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handler.handle(asChatInput);

        expect(backend.addIdentifier).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('email') as unknown as string })
        );
    });

    test('replies with not-found message when ContactNotFoundError thrown', async () => {
        backend.addIdentifier.mockImplementation(async () => {
            throw new ContactNotFoundError('no-such-person' as Contact['personId']);
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'no-such-person',
            platform: 'email',
            id:       'x@x.com',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('not found') as unknown as string })
        );
    });

    test('replies with generic error message on other errors', async () => {
        backend.addIdentifier.mockImplementation(async () => {
            throw new Error('Unknown failure');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'bad@bad.com',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Failed to link') as unknown as string })
        );
    });
});

// ---------------------------------------------------------------------------
// ContactCommandHandler — unlink subcommand
// ---------------------------------------------------------------------------

describe('ContactCommandHandler - unlink subcommand', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactCommandHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        mockLogger.error.mockClear();
    });

    test('calls removeIdentifier with correct arguments', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'unlink', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handler.handle(asChatInput);

        expect(backend.removeIdentifier).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('alice@example.com') as unknown as string })
        );
    });

    test('replies with not-found message when ContactNotFoundError thrown', async () => {
        backend.removeIdentifier.mockImplementation(async () => {
            throw new ContactNotFoundError('no-such-person' as Contact['personId']);
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'unlink', {
            person:   'no-such-person',
            platform: 'email',
            id:       'x@x.com',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('not found') as unknown as string })
        );
    });

    test('replies with error on ContactLastIdentifierError', async () => {
        backend.removeIdentifier.mockImplementation(async () => {
            throw new ContactLastIdentifierError('alice-wonderland' as Contact['personId']);
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'unlink', {
            person:   'alice-wonderland',
            platform: 'name',
            id:       'Alice Wonderland',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Failed to remove') as unknown as string })
        );
    });
});

// ---------------------------------------------------------------------------
// ContactCommandHandler — list subcommand
// ---------------------------------------------------------------------------

describe('ContactCommandHandler - list subcommand', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactCommandHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        mockLogger.error.mockClear();
    });

    test('replies with empty message when no contacts', async () => {
        backend.listContacts.mockImplementation(async () => []);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: 'No contacts in the address book.' })
        );
    });

    test('replies with formatted contact list', async () => {
        backend.listContacts.mockImplementation(async () => [SAMPLE_CONTACT]);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Alice Wonderland') as unknown as string })
        );
    });

    test('replies with error message when listContacts throws', async () => {
        backend.listContacts.mockImplementation(async () => {
            throw new Error('DynamoDB error');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: 'Failed to list contacts.' })
        );
    });
});

// ---------------------------------------------------------------------------
// ContactCommandHandler — show subcommand
// ---------------------------------------------------------------------------

describe('ContactCommandHandler - show subcommand', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactCommandHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        mockLogger.error.mockClear();
    });

    test('shows contact by exact personId', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        expect(backend.getContact).toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
    });

    test('falls back to fuzzy lookup when getContact returns undefined', async () => {
        backend.getContact.mockImplementation(async () => undefined);
        backend.fuzzyLookup.mockImplementation(async () => [SAMPLE_CONTACT]);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice',
        });

        await handler.handle(asChatInput);

        expect(backend.fuzzyLookup).toHaveBeenCalledWith('alice');
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
    });

    test('replies with not-found message when no contacts match', async () => {
        backend.getContact.mockImplementation(async () => undefined);
        backend.fuzzyLookup.mockImplementation(async () => []);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'unknown-person',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('No contact found') as unknown as string })
        );
    });

    test('uses fuzzy lookup directly for non-kebab-case query', async () => {
        backend.fuzzyLookup.mockImplementation(async () => [SAMPLE_CONTACT]);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'Alice Wonderland',
        });

        await handler.handle(asChatInput);

        expect(backend.fuzzyLookup).toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
    });

    test('embed includes Person ID, Identifiers, and Updated fields for contact with identifiers', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        const callArgs  = (editReply.mock.calls[0] as [{ embeds: import('discord.js').EmbedBuilder[] }])[0];
        const embedJson = callArgs.embeds[0]?.toJSON();
        const fieldNames = (embedJson?.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).toContain('Person ID');
        expect(fieldNames).toContain('Identifiers');
        expect(fieldNames).toContain('Updated');
    });

    test('embed omits Notes field for contact without notes', async () => {
        const contactWithoutNotes: Contact = {
            personId:    'alice-wonderland' as Contact['personId'],
            displayName: 'Alice Wonderland',
            identifiers: [{ platform: 'name', value: 'Alice Wonderland' }],
            createdAt:   '2025-01-01T00:00:00.000Z',
            updatedAt:   '2025-01-01T00:00:00.000Z',
        };
        backend.getContact.mockImplementation(async () => contactWithoutNotes);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        const callArgs  = (editReply.mock.calls[0] as [{ embeds: import('discord.js').EmbedBuilder[] }])[0];
        const embedJson = callArgs.embeds[0]?.toJSON();
        const fieldNames = (embedJson?.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).not.toContain('Notes');
    });

    test('embed includes Notes field for contact with notes', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        const callArgs  = (editReply.mock.calls[0] as [{ embeds: import('discord.js').EmbedBuilder[] }])[0];
        const embedJson = callArgs.embeds[0]?.toJSON();
        const fieldNames = (embedJson?.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).toContain('Notes');
    });

    test('replies with error message when backend throws', async () => {
        backend.getContact.mockImplementation(async () => {
            throw new Error('Backend error');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Failed to show contact') as unknown as string })
        );
    });
});

// ---------------------------------------------------------------------------
// ContactApprovalHandler
// ---------------------------------------------------------------------------

describe('ContactApprovalHandler - handleButton()', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactApprovalHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactApprovalHandler(backend as unknown as ContactBackend);
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
    });

    test('returns early for unknown prefix', async () => {
        const { interaction, deferUpdate } = makeButtonInteraction('other-prefix:abc123');

        await handler.handleButton(interaction);

        expect(deferUpdate).not.toHaveBeenCalled();
    });

    test('returns early when customId has no colon', async () => {
        const { interaction, deferUpdate } = makeButtonInteraction('contact-approve');

        await handler.handleButton(interaction);

        expect(deferUpdate).not.toHaveBeenCalled();
    });

    test('returns early when uuid is empty', async () => {
        const { interaction, deferUpdate } = makeButtonInteraction('contact-approve:');

        await handler.handleButton(interaction);

        expect(deferUpdate).not.toHaveBeenCalled();
    });

    test('approve — calls putContact and shows Approved embed', async () => {
        const uuid    = 'test-uuid-approve';
        const request: ContactApprovalRequest = {
            action:         'create',
            personId:       'bob-smith',
            displayName:    'Bob Smith',
            addIdentifiers: [{ platform: 'email', value: 'bob@example.com' }],
        };
        handler.storePendingRequest(uuid, request);

        const { interaction, deferUpdate, editReply } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        expect(deferUpdate).toHaveBeenCalledTimes(1);
        expect(backend.putContact).toHaveBeenCalledTimes(1);
        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.displayName).toBe('Bob Smith');
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
    });

    test('approve — shows not-found embed when uuid not in pending requests', async () => {
        const { interaction, editReply } = makeButtonInteraction('contact-approve:nonexistent-uuid');

        await handler.handleButton(interaction);

        expect(backend.putContact).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
    });

    test('approve — update action calls addIdentifier for each addIdentifier', async () => {
        const uuid    = 'test-uuid-update';
        const request: ContactApprovalRequest = {
            action:         'update',
            personId:       'alice-wonderland',
            addIdentifiers: [
                { platform: 'email', value: 'alice@new.com' },
                { platform: 'bsky',  value: 'alice.bsky.social' },
            ],
        };
        handler.storePendingRequest(uuid, request);

        const { interaction } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        expect(backend.addIdentifier).toHaveBeenCalledTimes(2);
    });

    test('approve — update action calls removeIdentifier for each removeIdentifier', async () => {
        const uuid    = 'test-uuid-remove-ids';
        const request: ContactApprovalRequest = {
            action:            'update',
            personId:          'alice-wonderland',
            removeIdentifiers: [
                { platform: 'email', value: 'alice@old.com' },
            ],
        };
        handler.storePendingRequest(uuid, request);

        const { interaction } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        expect(backend.removeIdentifier).toHaveBeenCalledTimes(1);
        expect(backend.addIdentifier).not.toHaveBeenCalled();
    });

    test('approve — update action handles both addIdentifiers and removeIdentifiers', async () => {
        const uuid    = 'test-uuid-mixed';
        const request: ContactApprovalRequest = {
            action:            'update',
            personId:          'alice-wonderland',
            addIdentifiers:    [{ platform: 'discord', value: 'alice#9999' }],
            removeIdentifiers: [{ platform: 'email', value: 'alice@old.com' }],
        };
        handler.storePendingRequest(uuid, request);

        const { interaction } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        expect(backend.addIdentifier).toHaveBeenCalledTimes(1);
        expect(backend.removeIdentifier).toHaveBeenCalledTimes(1);
    });

    test('approve — update action with notes fetches existing and calls putContact', async () => {
        const uuid    = 'test-uuid-notes';
        const request: ContactApprovalRequest = {
            action:   'update',
            personId: 'alice-wonderland',
            notes:    'Updated notes',
        };
        handler.storePendingRequest(uuid, request);
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);

        const { interaction } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        expect(backend.getContact).toHaveBeenCalled();
        expect(backend.putContact).toHaveBeenCalledTimes(1);
        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.notes).toBe('Updated notes');
    });

    test('approve — removes pending request after approval', async () => {
        const uuid    = 'test-uuid-remove';
        const request: ContactApprovalRequest = {
            action:         'create',
            displayName:    'Charlie',
            addIdentifiers: [{ platform: 'name', value: 'Charlie' }],
        };
        handler.storePendingRequest(uuid, request);

        const { interaction } = makeButtonInteraction(`contact-approve:${uuid}`);
        await handler.handleButton(interaction);

        // Second press should show not-found embed (pending removed)
        const { interaction: interaction2, editReply: editReply2 } = makeButtonInteraction(`contact-approve:${uuid}`);
        await handler.handleButton(interaction2);

        expect(backend.putContact).toHaveBeenCalledTimes(1); // Only once
        expect(editReply2).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
    });

    test('reject — shows Rejected embed and removes pending request', async () => {
        const uuid    = 'test-uuid-reject';
        const request: ContactApprovalRequest = {
            action:         'create',
            displayName:    'Dave',
            addIdentifiers: [{ platform: 'name', value: 'Dave' }],
        };
        handler.storePendingRequest(uuid, request);

        const { interaction, deferUpdate, editReply } = makeButtonInteraction(`contact-reject:${uuid}`);

        await handler.handleButton(interaction);

        expect(deferUpdate).toHaveBeenCalledTimes(1);
        expect(backend.putContact).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
    });

    test('reject — shows not-found embed when uuid not in pending requests', async () => {
        const { interaction, editReply } = makeButtonInteraction('contact-reject:nonexistent-uuid');

        await handler.handleButton(interaction);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
    });

    test('shows error embed when approve throws', async () => {
        const uuid    = 'test-uuid-error';
        const request: ContactApprovalRequest = {
            action:         'create',
            displayName:    'Error Case',
            addIdentifiers: [{ platform: 'name', value: 'Error Case' }],
        };
        handler.storePendingRequest(uuid, request);
        backend.putContact.mockImplementation(async () => {
            throw new Error('DynamoDB failure');
        });

        const { interaction, editReply } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('error occurred') as unknown as string })
        );
    });

    test('approve create — appends -2 suffix when personId from request is already taken', async () => {
        const uuid    = 'test-uuid-suffix';
        const request: ContactApprovalRequest = {
            action:         'create',
            personId:       'bob-smith',
            displayName:    'Bob Smith',
            addIdentifiers: [{ platform: 'name', value: 'Bob Smith' }],
        };
        handler.storePendingRequest(uuid, request);

        backend.getContact
            .mockResolvedValueOnce(SAMPLE_CONTACT)  // 'bob-smith' is taken
            .mockResolvedValueOnce(undefined);       // 'bob-smith-2' is free

        const { interaction } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        expect(backend.putContact).toHaveBeenCalledTimes(1);
        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(String(contact.personId)).toBe('bob-smith-2');
    });
});
