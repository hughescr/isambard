import { describe, test, expect, beforeEach, mock, type Mock } from 'bun:test';
import { MessageFlags, type ActionRowBuilder, type ButtonBuilder, type ButtonInteraction, type ChatInputCommandInteraction, type EmbedBuilder } from 'discord.js';
import { z } from 'zod';
import {
    buildContactCommand,
    buildContactApprovalEmbed,
    buildDeleteConfirmationEmbed,
    ContactCommandHandler,
    ContactApprovalHandler
} from '../../../../src/integrations/discord/contact-commands';
import { mockLogger } from '../../../setup';
import { ContactNotFoundError, ContactLastIdentifierError } from '@/errors';
import { createPersonId, type Contact, type ContactBackend, type ContactChangeRequest, type PersonAllowlist } from '@/storage';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADMIN_USER_ID = '423276934781468692';

const SAMPLE_CONTACT: Contact = {
    personId:    createPersonId('alice-wonderland'),
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

function controlledPromise<T>(): { promise: Promise<T>, start: () => void, started: Promise<void>, resolve: (value: T) => void } {
    const gate = Promise.withResolvers<T>();
    const signal = Promise.withResolvers<void>();
    return {
        promise: gate.promise,
        start:   () => signal.resolve(),
        started: signal.promise,
        resolve: gate.resolve,
    };
}

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

    test('has add, link, unlink, list, show, edit, and delete subcommands', () => {
        const cmd          = buildContactCommand();
        const json         = cmd.toJSON();
        const subcommands  = json.options ?? [];
        const names        = subcommands.map((s: { name: string }) => s.name);
        expect(names).toContain('add');
        expect(names).toContain('link');
        expect(names).toContain('unlink');
        expect(names).toContain('list');
        expect(names).toContain('show');
        expect(names).toContain('edit');
        expect(names).toContain('delete');
    });

    test('preserves the required and optional fields in each contact command form', () => {
        const options = buildContactCommand().toJSON().options as { name: string, options?: { name: string, required?: boolean }[] }[];
        const command = (name: string) => options.find(option => option.name === name)!;
        const required = (subcommand: string, option: string) => command(subcommand).options!.find(entry => entry.name === option)!.required;

        expect(required('add', 'name')).toBe(true);
        expect(required('add', 'discord')).toBe(false);
        expect(required('link', 'person')).toBe(true);
        expect(required('link', 'platform')).toBe(true);
        expect(required('link', 'id')).toBe(true);
        expect(required('unlink', 'person')).toBe(true);
        expect(required('unlink', 'platform')).toBe(true);
        expect(required('unlink', 'id')).toBe(true);
    });

    test('edit subcommand has required person option and optional name and notes options', () => {
        const cmd        = buildContactCommand();
        const json       = cmd.toJSON();
        const editCmd    = (json.options ?? []).find((o: { name: string }) => o.name === 'edit');
        expect(editCmd).toBeDefined();
        const editOptions: { name: string, required?: boolean, min_length?: number }[] = (editCmd as { options?: { name: string, required?: boolean, min_length?: number }[] }).options ?? [];
        const personOpt = editOptions.find(o => o.name === 'person');
        expect(personOpt).toBeDefined();
        expect(personOpt?.required).toBe(true);
        const nameOpt = editOptions.find(o => o.name === 'name');
        expect(nameOpt).toBeDefined();
        expect(nameOpt?.required).toBeFalsy();
        expect(nameOpt?.min_length).toBe(1);
        const notesOpt = editOptions.find(o => o.name === 'notes');
        expect(notesOpt).toBeDefined();
        expect(notesOpt?.required).toBeFalsy();
        expect(notesOpt?.min_length).toBe(0);
    });

    test('delete subcommand has required person option', () => {
        const cmd       = buildContactCommand();
        const json      = cmd.toJSON();
        const deleteCmd = (json.options ?? []).find((o: { name: string }) => o.name === 'delete');
        expect(deleteCmd).toBeDefined();
        const deleteOptions: { name: string, required?: boolean }[] = (deleteCmd as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const personOpt = deleteOptions.find(o => o.name === 'person');
        expect(personOpt).toBeDefined();
        expect(personOpt?.required).toBe(true);
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
        const request: ContactChangeRequest = {
            action:         'create',
            displayName:    'Bob Smith',
            addIdentifiers: [{ platform: 'email', value: 'bob@example.com' }],
        };
        const { embed, actionRow } = buildContactApprovalEmbed(request);
        expect(embed).toBeDefined();
        expect(actionRow).toBeDefined();
    });

    test('create request has "Contact Create Request" title', () => {
        const request: ContactChangeRequest = { action: 'create', displayName: 'Bob', addIdentifiers: [] };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        expect(json.title).toBe('Contact Create Request');
    });

    test('update request has "Contact Update Request" title', () => {
        const request: ContactChangeRequest = { action: 'update', personId: createPersonId('bob-smith') };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        expect(json.title).toBe('Contact Update Request');
    });

    test('includes displayName field when present', () => {
        const request: ContactChangeRequest = { action: 'create', displayName: 'Charlie', addIdentifiers: [] };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const field = json.fields?.find((f: { name: string }) => f.name === 'Display Name');
        expect(field).toBeDefined();
        expect(field?.value).toBe('Charlie');
    });

    test('includes personId field when present', () => {
        const request: ContactChangeRequest = { action: 'update', personId: createPersonId('alice-wonderland') };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const field = json.fields?.find((f: { name: string }) => f.name === 'Person ID');
        expect(field).toBeDefined();
        expect(field?.value).toBe('alice-wonderland');
    });

    test('includes Add Identifiers field when addIdentifiers present', () => {
        const request: ContactChangeRequest = {
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
        const request: ContactChangeRequest = {
            action:            'update',
            personId:          createPersonId('dave-smith'),
            removeIdentifiers: [{ platform: 'email', value: 'dave@example.com' }],
        };
        const { embed } = buildContactApprovalEmbed(request);
        const json      = embed.toJSON();
        const field     = json.fields?.find((f: { name: string }) => f.name === 'Remove Identifiers');
        expect(field).toBeDefined();
        expect(field?.value).toContain('email: dave@example.com');
    });

    test('shows both Add Identifiers and Remove Identifiers when both present', () => {
        const request: ContactChangeRequest = {
            action:            'update',
            personId:          createPersonId('dave-smith'),
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
        const request: ContactChangeRequest = { action: 'create', displayName: 'Eve', addIdentifiers: [], notes: 'Test note' };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const field = json.fields?.find((f: { name: string }) => f.name === 'Notes');
        expect(field).toBeDefined();
        expect(field?.value).toBe('Test note');
    });

    test('uses compact fields only for the identity metadata', () => {
        const { embed } = buildContactApprovalEmbed({
            action:         'create',
            displayName:    'Eve',
            personId:       createPersonId('eve-example'),
            addIdentifiers: [{ platform: 'email', value: 'eve@example.com' }],
            notes:          'A note',
        });
        const fields = Object.fromEntries((embed.toJSON().fields ?? []).map(field => [field.name, field]));

        expect(fields['Display Name'].inline).toBe(true);
        expect(fields['Person ID'].inline).toBe(true);
        expect(fields['Add Identifiers'].inline).toBe(false);
        expect(fields.Notes.inline).toBe(false);
    });

    test('actionRow has approve and reject buttons', () => {
        const request: ContactChangeRequest = { action: 'create', displayName: 'Frank', addIdentifiers: [] };
        const { actionRow }                    = buildContactApprovalEmbed(request);
        const json                             = actionRow.toJSON();
        // ActionRow has components (buttons)
        expect(json.components).toHaveLength(2);
        const ids = json.components.map(c => (c as unknown as { custom_id?: string }).custom_id ?? '');
        expect(ids.some((id: string) => id.startsWith('contact-approve:'))).toBe(true);
        expect(ids.some((id: string) => id.startsWith('contact-reject:'))).toBe(true);
    });

    test('omits Add Identifiers field when addIdentifiers is empty array', () => {
        const request: ContactChangeRequest = { action: 'create', displayName: 'Henry', addIdentifiers: [] };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const fieldNames = (json.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).not.toContain('Add Identifiers');
    });

    test('omits Remove Identifiers field when removeIdentifiers is empty array', () => {
        const request: ContactChangeRequest = { action: 'update', personId: createPersonId('henry-smith'), removeIdentifiers: [] };
        const { embed }                        = buildContactApprovalEmbed(request);
        const json                             = embed.toJSON();
        const fieldNames = (json.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).not.toContain('Remove Identifiers');
    });

    test('Add Identifiers field uses newline separator for multiple identifiers', () => {
        const request: ContactChangeRequest = {
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
        const request: ContactChangeRequest = { action: 'create', displayName: 'Grace', addIdentifiers: [] };
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
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            displayName: 'Fail Case',
            msg:         'Failed to create contact',
        }));
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
        mockLogger.warn.mockClear();
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
            throw new ContactNotFoundError('no-such-person');
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
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            personRaw: 'no-such-person',
            msg:       'Failed to link identifier',
        }));
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
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            personRaw: 'alice-wonderland',
            msg:       'Failed to link identifier',
        }));
    });

    test('calls refreshPerson after successful addIdentifier', async () => {
        const mockPersonAllowlist = {
            refreshPerson: mock(async (): Promise<void> => {}),
            removePerson:  mock(async (): Promise<void> => {}),
        } as unknown as PersonAllowlist;
        const handlerWithAllowlist = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, undefined, mockPersonAllowlist);
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handlerWithAllowlist.handle(asChatInput);

        expect((mockPersonAllowlist.refreshPerson as Mock<(...args: unknown[]) => Promise<void>>)).toHaveBeenCalledWith(expect.stringContaining('alice-wonderland'));
    });

    test('logs warning and does not throw when refreshPerson fails', async () => {
        const mockPersonAllowlist = {
            refreshPerson: mock(async (): Promise<void> => { throw new Error('refresh failed'); }),
            removePerson:  mock(async (): Promise<void> => {}),
        } as unknown as PersonAllowlist;
        const handlerWithAllowlist = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, undefined, mockPersonAllowlist);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handlerWithAllowlist.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Added') as unknown as string })
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            personId: expect.stringContaining('alice-wonderland'),
            msg:      'Failed to refresh allowlist cache after link',
        }));
    });

    test('does not crash when personAllowlist is undefined', async () => {
        // handler without 4th arg
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Added') as unknown as string })
        );
    });

    test('replies with the exact link confirmation naming the linked value and the person', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({ content: 'Added email: alice@example.com to contact `alice-wonderland`.' });
    });

    test('unwraps an Error message rather than stringifying the error object in the link failure reply', async () => {
        backend.addIdentifier.mockImplementation(async () => {
            throw new Error('Unknown failure');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'bad@bad.com',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({ content: 'Failed to link identifier: Unknown failure' });
    });

    test('rejects an invalid contact id before adding an identifier', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'Alice Wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handler.handle(asChatInput);

        expect(backend.addIdentifier).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('personId must be lowercase') as unknown as string }));
    });

    test('renders a non-Error link failure with its string value', async () => {
        backend.addIdentifier.mockImplementation(async () => {
            throw 'backend unavailable';
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'link', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({ content: 'Failed to link identifier: backend unavailable' });
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
        mockLogger.warn.mockClear();
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
            throw new ContactNotFoundError('no-such-person');
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
            throw new ContactLastIdentifierError('alice-wonderland');
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
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            personRaw: 'alice-wonderland',
            msg:       'Failed to unlink identifier',
        }));
    });

    test('renders a non-Error unlink failure with its string value', async () => {
        backend.removeIdentifier.mockImplementation(async () => {
            throw 'backend unavailable';
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'unlink', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({ content: 'Failed to remove identifier: backend unavailable' });
    });

    test('calls refreshPerson after successful removeIdentifier', async () => {
        const mockPersonAllowlist = {
            refreshPerson: mock(async (): Promise<void> => {}),
            removePerson:  mock(async (): Promise<void> => {}),
        } as unknown as PersonAllowlist;
        const handlerWithAllowlist = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, undefined, mockPersonAllowlist);
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'unlink', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handlerWithAllowlist.handle(asChatInput);

        expect((mockPersonAllowlist.refreshPerson as Mock<(...args: unknown[]) => Promise<void>>)).toHaveBeenCalledWith(expect.stringContaining('alice-wonderland'));
    });

    test('logs warning and does not throw when refreshPerson fails on unlink', async () => {
        const mockPersonAllowlist = {
            refreshPerson: mock(async (): Promise<void> => { throw new Error('refresh failed'); }),
            removePerson:  mock(async (): Promise<void> => {}),
        } as unknown as PersonAllowlist;
        const handlerWithAllowlist = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, undefined, mockPersonAllowlist);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'unlink', {
            person:   'alice-wonderland',
            platform: 'email',
            id:       'alice@example.com',
        });

        await handlerWithAllowlist.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Removed') as unknown as string })
        );
        expect(mockLogger.warn).toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            personId: expect.stringContaining('alice-wonderland'),
            msg:      'Failed to refresh allowlist cache after unlink',
        }));
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
        backend.listContacts.mockImplementation(async () => [
            SAMPLE_CONTACT,
            { ...SAMPLE_CONTACT, personId: createPersonId('bob-smith'), displayName: 'Bob Smith', identifiers: [{ platform: 'discord', value: 'bob' }] },
        ]);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({
            content: '**Alice Wonderland** (`alice-wonderland`) — name, email\n**Bob Smith** (`bob-smith`) — discord',
        });

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
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Failed to list contacts',
        }));
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

        const callArgs  = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const embedJson = callArgs.embeds[0].toJSON();
        const fieldNames = (embedJson.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).toContain('Person ID');
        expect(fieldNames).toContain('Identifiers');
        expect(fieldNames).toContain('Updated');
        const fields = Object.fromEntries((embedJson.fields ?? []).map(field => [field.name, field]));
        expect(fields['Person ID'].inline).toBe(true);
        expect(fields.Identifiers.inline).toBe(false);
        expect(fields.Notes.inline).toBe(false);
        expect(fields.Updated.inline).toBe(true);
    });

    test('embed omits Notes field for contact without notes', async () => {
        const contactWithoutNotes: Contact = {
            personId:    createPersonId('alice-wonderland'),
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

        const callArgs  = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const embedJson = callArgs.embeds[0].toJSON();
        const fieldNames = (embedJson.fields ?? []).map((f: { name: string }) => f.name);
        expect(fieldNames).not.toContain('Notes');
    });

    test('embed omits Identifiers field for a contact without identifiers', async () => {
        const contactWithoutIdentifiers: Contact = {
            ...SAMPLE_CONTACT,
            identifiers: [],
        };
        backend.getContact.mockResolvedValue(contactWithoutIdentifiers);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        const callArgs = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const fieldNames = (callArgs.embeds[0].toJSON().fields ?? []).map(field => field.name);
        expect(fieldNames).not.toContain('Identifiers');
    });

    test('embed includes Notes field for contact with notes', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        const callArgs  = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const embedJson = callArgs.embeds[0].toJSON();
        const fieldNames = (embedJson.fields ?? []).map((f: { name: string }) => f.name);
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
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            personRaw: 'alice-wonderland',
            msg:       'Failed to show contact',
        }));
    });

    test('uses fuzzy lookup for malformed IDs, including a trailing separator and mixed case', async () => {
        backend.fuzzyLookup.mockResolvedValue([SAMPLE_CONTACT]);

        const trailingSeparator = createMockInteraction(ADMIN_USER_ID, 'show', { person: 'alice-' });
        const mixedCase = createMockInteraction(ADMIN_USER_ID, 'show', { person: 'Alice' });

        await handler.handle(trailingSeparator.asChatInput);
        await handler.handle(mixedCase.asChatInput);

        expect(backend.getContact).not.toHaveBeenCalled();
        expect(backend.fuzzyLookup).toHaveBeenCalledWith('alice-');
        expect(backend.fuzzyLookup).toHaveBeenCalledWith('Alice');
    });

    test('falls back to fuzzy lookup when exact lookup rejects an ID validation error', async () => {
        backend.getContact.mockImplementation(async () => {
            throw z.string().parse(1);
        });
        backend.fuzzyLookup.mockResolvedValue([SAMPLE_CONTACT]);
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'show', { person: 'a' });

        await handler.handle(asChatInput);

        expect(backend.fuzzyLookup).toHaveBeenCalledWith('a');
    });

    test('unwraps an Error message rather than its name or the stringified error in the show failure reply', async () => {
        backend.getContact.mockImplementation(async () => {
            throw new Error('Backend error');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({ content: 'Failed to show contact: Backend error' });
    });

    test('stringifies a non-Error rejection rather than naming the queried person in the show failure reply', async () => {
        backend.getContact.mockImplementation(async () => {
            throw 'dead'; // a non-Error rejection is exactly what this branch stringifies
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({ content: 'Failed to show contact: dead' });
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

    test.each([
        { desc: 'unknown prefix', customId: 'other-prefix:abc123' },
        { desc: 'customId has no colon', customId: 'contact-approve' },
        { desc: 'uuid is empty', customId: 'contact-approve:' }
    ])('returns early when $desc', async ({ customId }) => {
        const { interaction, deferUpdate } = makeButtonInteraction(customId);

        await handler.handleButton(interaction);

        expect(deferUpdate).not.toHaveBeenCalled();
    });

    test('approve — calls putContact and shows Approved embed', async () => {
        const uuid    = 'test-uuid-approve';
        const request: ContactChangeRequest = {
            action:         'create',
            personId:       createPersonId('bob-smith'),
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
        expect(mockLogger.info).toHaveBeenCalledWith({
            personId:    createPersonId('bob-smith'),
            displayName: 'Bob Smith',
            msg:         'Contact created via admin approval',
        });
    });

    test('approve — titles the embed Approved rather than Denied', async () => {
        const uuid = 'test-uuid-approve-title';
        handler.storePendingRequest(uuid, { action: 'create', personId: createPersonId('bob-smith'), displayName: 'Bob Smith', addIdentifiers: [] });

        const { interaction, editReply } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        const callArgs = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        expect(callArgs.embeds[0].toJSON().title).toBe('Approved \u2713');
    });

    test('approve — shows not-found embed when uuid not in pending requests', async () => {
        const { interaction, editReply } = makeButtonInteraction('contact-approve:nonexistent-uuid');

        await handler.handleButton(interaction);

        expect(backend.putContact).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
        expect(mockLogger.warn).toHaveBeenCalledWith({
            uuid: 'nonexistent-uuid',
            msg:  'Contact approval: no pending request found for uuid',
        });
    });

    test('approve — update action calls addIdentifier for each addIdentifier', async () => {
        const uuid    = 'test-uuid-update';
        const request: ContactChangeRequest = {
            action:         'update',
            personId:       createPersonId('alice-wonderland'),
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
        const request: ContactChangeRequest = {
            action:            'update',
            personId:          createPersonId('alice-wonderland'),
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
        const request: ContactChangeRequest = {
            action:            'update',
            personId:          createPersonId('alice-wonderland'),
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
        const request: ContactChangeRequest = {
            action:   'update',
            personId: createPersonId('alice-wonderland'),
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

    test('approve — update action without notes does not overwrite the contact', async () => {
        const uuid = 'test-uuid-no-notes';
        handler.storePendingRequest(uuid, { action: 'update', personId: createPersonId('alice-wonderland') });
        const { interaction } = makeButtonInteraction(`contact-approve:${uuid}`);

        await handler.handleButton(interaction);

        expect(backend.getContact).not.toHaveBeenCalled();
        expect(backend.putContact).not.toHaveBeenCalled();
    });

    test('approve — update refreshes the allowlist after a successful update', async () => {
        const allowlist = {
            refreshPerson: mock(async (): Promise<void> => {}),
            removePerson:  mock(async (): Promise<void> => {}),
        } as unknown as PersonAllowlist;
        const allowlistedHandler = new ContactApprovalHandler(backend as unknown as ContactBackend, allowlist);
        const uuid = 'test-uuid-update-allowlist';
        allowlistedHandler.storePendingRequest(uuid, {
            action: 'update', personId: createPersonId('alice-wonderland'), addIdentifiers: [{ platform: 'email', value: 'new@example.com' }],
        });

        await allowlistedHandler.handleButton(makeButtonInteraction(`contact-approve:${uuid}`).interaction);

        expect((allowlist.refreshPerson as Mock<(...args: unknown[]) => Promise<void>>)).toHaveBeenCalledWith('alice-wonderland');
        expect(mockLogger.info).toHaveBeenCalledWith({ personId: createPersonId('alice-wonderland'), msg: 'Contact updated via admin approval' });
    });

    test('approve — update logs but succeeds when allowlist refresh fails', async () => {
        const allowlist = {
            refreshPerson: mock(async (): Promise<void> => { throw new Error('refresh failed'); }),
            removePerson:  mock(async (): Promise<void> => {}),
        } as unknown as PersonAllowlist;
        const allowlistedHandler = new ContactApprovalHandler(backend as unknown as ContactBackend, allowlist);
        const uuid = 'test-uuid-update-allowlist-failure';
        allowlistedHandler.storePendingRequest(uuid, { action: 'update', personId: createPersonId('alice-wonderland') });

        await allowlistedHandler.handleButton(makeButtonInteraction(`contact-approve:${uuid}`).interaction);

        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            personId: createPersonId('alice-wonderland'),
            msg:      'Failed to refresh allowlist cache after contact update',
        }));
    });

    test('approve — removes pending request after approval', async () => {
        const uuid    = 'test-uuid-remove';
        const request: ContactChangeRequest = {
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
        const request: ContactChangeRequest = {
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
        expect(mockLogger.info).toHaveBeenCalledWith({
            action:   'create',
            personId: undefined,
            msg:      'Contact change request rejected by admin',
        });

        const { interaction: secondPress } = makeButtonInteraction(`contact-reject:${uuid}`);
        await handler.handleButton(secondPress);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            uuid,
            msg: 'Contact rejection: no pending request found for uuid',
        });
    });

    test('reject — shows not-found embed when uuid not in pending requests', async () => {
        const { interaction, editReply } = makeButtonInteraction('contact-reject:nonexistent-uuid');

        await handler.handleButton(interaction);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ embeds: expect.arrayContaining([expect.anything()]) as unknown as unknown[] })
        );
        expect(mockLogger.warn).toHaveBeenCalledWith({
            uuid: 'nonexistent-uuid',
            msg:  'Contact rejection: no pending request found for uuid',
        });
    });

    test('shows error embed when approve throws', async () => {
        const uuid    = 'test-uuid-error';
        const request: ContactChangeRequest = {
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
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            uuid,
            prefix: 'contact-approve',
            msg:    'Contact approval button handler failed',
        }));
    });

    test('logs the secondary error when the failure reply cannot be sent', async () => {
        const uuid = 'test-uuid-error-reply';
        handler.storePendingRequest(uuid, { action: 'create', displayName: 'Error Case', addIdentifiers: [] });
        backend.putContact.mockImplementation(async () => {
            throw new Error('DynamoDB failure');
        });
        const { interaction } = makeButtonInteraction(`contact-approve:${uuid}`);
        const editReply = interaction.editReply as unknown as Mock<(...args: unknown[]) => Promise<void>>;
        editReply.mockImplementation(async () => {
            throw new Error('Discord unavailable');
        });

        await handler.handleButton(interaction);

        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            msg: 'Failed to send error editReply for contact approval',
        }));
    });

    test('approve create — appends -2 suffix when personId from request is already taken', async () => {
        const uuid    = 'test-uuid-suffix';
        const request: ContactChangeRequest = {
            action:         'create',
            personId:       createPersonId('bob-smith'),
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

// ---------------------------------------------------------------------------
// buildDeleteConfirmationEmbed tests
// ---------------------------------------------------------------------------

describe('buildDeleteConfirmationEmbed()', () => {
    test('returns embed and actionRow', () => {
        const { embed, actionRow } = buildDeleteConfirmationEmbed(SAMPLE_CONTACT, 'test-uuid');
        expect(embed).toBeDefined();
        expect(actionRow).toBeDefined();
    });

    test('embed contains contact display name as title', () => {
        const { embed } = buildDeleteConfirmationEmbed(SAMPLE_CONTACT, 'test-uuid');
        const json      = embed.toJSON();
        expect(json.title).toBe('Alice Wonderland');
    });

    test('embed contains "Are you sure" description', () => {
        const { embed } = buildDeleteConfirmationEmbed(SAMPLE_CONTACT, 'test-uuid');
        const json      = embed.toJSON();
        expect(json.description).toContain('Are you sure');
    });

    test('embed contains Person ID field', () => {
        const { embed } = buildDeleteConfirmationEmbed(SAMPLE_CONTACT, 'test-uuid');
        const json      = embed.toJSON();
        const field     = json.fields?.find((f: { name: string }) => f.name === 'Person ID');
        expect(field).toBeDefined();
        expect(field?.value).toBe('alice-wonderland');
    });

    test('embed contains Identifiers field', () => {
        const { embed } = buildDeleteConfirmationEmbed(SAMPLE_CONTACT, 'test-uuid');
        const json      = embed.toJSON();
        const field     = json.fields?.find((f: { name: string }) => f.name === 'Identifiers');
        expect(field).toBeDefined();
    });

    test('embed contains Updated field', () => {
        const { embed } = buildDeleteConfirmationEmbed(SAMPLE_CONTACT, 'test-uuid');
        const json      = embed.toJSON();
        const field     = json.fields?.find((f: { name: string }) => f.name === 'Updated');
        expect(field).toBeDefined();
    });

    test('actionRow has confirm and cancel buttons with correct customId prefixes', () => {
        const uuid          = 'my-test-uuid';
        const { actionRow } = buildDeleteConfirmationEmbed(SAMPLE_CONTACT, uuid);
        const json          = actionRow.toJSON();
        expect(json.components).toHaveLength(2);
        const components = json.components as unknown as { custom_id?: string }[];
        expect(components.some(c => c.custom_id === `contact-delete-confirm:${uuid}`)).toBe(true);
        expect(components.some(c => c.custom_id === `contact-delete-cancel:${uuid}`)).toBe(true);
    });

    test('confirm button has Success style, cancel has Secondary style', () => {
        const { actionRow } = buildDeleteConfirmationEmbed(SAMPLE_CONTACT, 'test-uuid');
        const json          = actionRow.toJSON();
        const components    = json.components as unknown as { style: number, custom_id?: string }[];
        const confirmBtn    = components.find(c => c.custom_id?.startsWith('contact-delete-confirm:'));
        const cancelBtn     = components.find(c => c.custom_id?.startsWith('contact-delete-cancel:'));
        // ButtonStyle.Success = 3, ButtonStyle.Secondary = 2
        expect(confirmBtn?.style).toBe(3);
        expect(cancelBtn?.style).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// ContactCommandHandler — delete subcommand
// ---------------------------------------------------------------------------

describe('ContactCommandHandler - delete subcommand', () => {
    let backend:         ReturnType<typeof createMockBackend>;
    let approvalHandler: ContactApprovalHandler;
    let handler:         ContactCommandHandler;

    beforeEach(() => {
        backend         = createMockBackend();
        approvalHandler = new ContactApprovalHandler(backend as unknown as ContactBackend);
        handler         = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, approvalHandler);
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
    });

    test('shows confirmation embed when contact found by exact personId', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'delete', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        expect(backend.getContact).toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({
                embeds:     expect.arrayContaining([expect.anything()]) as unknown as unknown[],
                components: expect.arrayContaining([expect.anything()]) as unknown as unknown[],
            })
        );
    });

    test('shows confirmation embed when contact found by fuzzy lookup', async () => {
        backend.getContact.mockImplementation(async () => undefined);
        backend.fuzzyLookup.mockImplementation(async () => [SAMPLE_CONTACT]);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'delete', {
            person: 'alice',
        });

        await handler.handle(asChatInput);

        expect(backend.fuzzyLookup).toHaveBeenCalledWith('alice');
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({
                embeds:     expect.arrayContaining([expect.anything()]) as unknown as unknown[],
                components: expect.arrayContaining([expect.anything()]) as unknown as unknown[],
            })
        );
    });

    test('replies not found when no contact matches', async () => {
        backend.getContact.mockImplementation(async () => undefined);
        backend.fuzzyLookup.mockImplementation(async () => []);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'delete', {
            person: 'unknown-person',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('No contact found') as unknown as string })
        );
    });

    test('replies not available when no approvalHandler', async () => {
        const handlerWithoutApproval = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'delete', {
            person: 'alice-wonderland',
        });

        await handlerWithoutApproval.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('not available') as unknown as string })
        );
    });

    test('stores pending deletion in approval handler', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const storeSpy = mock(() => {});
        approvalHandler.storePendingDeletion = storeSpy;

        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'delete', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        expect(storeSpy).toHaveBeenCalledWith(
            expect.any(String) as unknown,
            SAMPLE_CONTACT.personId
        );
    });

    test('replies with error on backend failure', async () => {
        backend.getContact.mockImplementation(async () => {
            throw new Error('Backend error');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'delete', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Failed') as unknown as string })
        );
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            personRaw: 'alice-wonderland',
            msg:       'Failed to delete contact',
        }));
    });
});

// ---------------------------------------------------------------------------
// ContactApprovalHandler — delete confirmation
// ---------------------------------------------------------------------------

describe('ContactApprovalHandler - delete confirmation', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactApprovalHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactApprovalHandler(backend as unknown as ContactBackend);
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
    });

    test('confirm button calls deleteContact and shows Deleted embed', async () => {
        const uuid = 'delete-confirm-uuid';
        handler.storePendingDeletion(uuid, SAMPLE_CONTACT.personId);

        const { interaction, deferUpdate, editReply } = makeButtonInteraction(`contact-delete-confirm:${uuid}`);

        await handler.handleButton(interaction);

        expect(deferUpdate).toHaveBeenCalledTimes(1);
        expect(backend.deleteContact).toHaveBeenCalledWith(SAMPLE_CONTACT.personId);
        const callArgs = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const title    = callArgs.embeds[0].toJSON().title;
        expect(title).toContain('Deleted');
    });

    test('cancel button shows Cancelled embed without calling deleteContact', async () => {
        const uuid = 'delete-cancel-uuid';
        handler.storePendingDeletion(uuid, SAMPLE_CONTACT.personId);

        const { interaction, deferUpdate, editReply } = makeButtonInteraction(`contact-delete-cancel:${uuid}`);

        await handler.handleButton(interaction);

        expect(deferUpdate).toHaveBeenCalledTimes(1);
        expect(backend.deleteContact).not.toHaveBeenCalled();
        const callArgs = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const title    = callArgs.embeds[0].toJSON().title;
        expect(title).toContain('Cancelled');
    });

    test('confirm with unknown UUID shows Request Not Found', async () => {
        const { interaction, editReply } = makeButtonInteraction('contact-delete-confirm:nonexistent-uuid');

        await handler.handleButton(interaction);

        expect(backend.deleteContact).not.toHaveBeenCalled();
        const callArgs = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const title    = callArgs.embeds[0].toJSON().title;
        expect(title).toBe('Request Not Found');
        expect(mockLogger.warn).toHaveBeenCalledWith({
            uuid: 'nonexistent-uuid',
            msg:  'Contact delete confirm: no pending deletion found for uuid',
        });
    });

    test('cancel with unknown UUID shows Request Not Found', async () => {
        const { interaction, editReply } = makeButtonInteraction('contact-delete-cancel:nonexistent-uuid');

        await handler.handleButton(interaction);

        expect(backend.deleteContact).not.toHaveBeenCalled();
        const callArgs = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const title    = callArgs.embeds[0].toJSON().title;
        expect(title).toBe('Request Not Found');
        expect(mockLogger.warn).toHaveBeenCalledWith({
            uuid: 'nonexistent-uuid',
            msg:  'Contact delete cancel: no pending deletion found for uuid',
        });
    });

    test('confirm removes pending deletion from map', async () => {
        const uuid = 'delete-confirm-remove-uuid';
        handler.storePendingDeletion(uuid, SAMPLE_CONTACT.personId);

        const { interaction } = makeButtonInteraction(`contact-delete-confirm:${uuid}`);
        await handler.handleButton(interaction);

        // Second press should show not-found (pending removed)
        const { interaction: interaction2, editReply: editReply2 } = makeButtonInteraction(`contact-delete-confirm:${uuid}`);
        await handler.handleButton(interaction2);

        expect(backend.deleteContact).toHaveBeenCalledTimes(1);
        const callArgs = (editReply2.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const title    = callArgs.embeds[0].toJSON().title;
        expect(title).toBe('Request Not Found');
    });

    test('cancel removes pending deletion from map', async () => {
        const uuid = 'delete-cancel-remove-uuid';
        handler.storePendingDeletion(uuid, SAMPLE_CONTACT.personId);

        const { interaction } = makeButtonInteraction(`contact-delete-cancel:${uuid}`);
        await handler.handleButton(interaction);

        // Second press should show not-found (pending removed)
        const { interaction: interaction2, editReply: editReply2 } = makeButtonInteraction(`contact-delete-cancel:${uuid}`);
        await handler.handleButton(interaction2);

        expect(backend.deleteContact).not.toHaveBeenCalled();
        const callArgs = (editReply2.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const title    = callArgs.embeds[0].toJSON().title;
        expect(title).toBe('Request Not Found');
    });

    test('error during deleteContact shows error reply', async () => {
        const uuid = 'delete-error-uuid';
        handler.storePendingDeletion(uuid, SAMPLE_CONTACT.personId);
        backend.deleteContact.mockImplementation(async () => {
            throw new Error('DynamoDB failure');
        });

        const { interaction, editReply } = makeButtonInteraction(`contact-delete-confirm:${uuid}`);

        await handler.handleButton(interaction);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('error occurred') as unknown as string })
        );
    });

    test('calls removePerson after successful deleteContact', async () => {
        const mockPersonAllowlist = {
            refreshPerson: mock(async (): Promise<void> => {}),
            removePerson:  mock(async (): Promise<void> => {}),
        } as unknown as PersonAllowlist;
        const handlerWithAllowlist = new ContactApprovalHandler(backend as unknown as ContactBackend, mockPersonAllowlist);
        const uuid = 'delete-allowlist-uuid';
        handlerWithAllowlist.storePendingDeletion(uuid, SAMPLE_CONTACT.personId);

        const { interaction } = makeButtonInteraction(`contact-delete-confirm:${uuid}`);

        await handlerWithAllowlist.handleButton(interaction);

        expect((mockPersonAllowlist.removePerson as Mock<(...args: unknown[]) => Promise<void>>)).toHaveBeenCalledWith(SAMPLE_CONTACT.personId);
    });

    test('logs warning and does not throw when removePerson fails', async () => {
        const mockPersonAllowlist = {
            refreshPerson: mock(async (): Promise<void> => {}),
            removePerson:  mock(async (): Promise<void> => { throw new Error('remove failed'); }),
        } as unknown as PersonAllowlist;
        const handlerWithAllowlist = new ContactApprovalHandler(backend as unknown as ContactBackend, mockPersonAllowlist);
        const uuid = 'delete-allowlist-fail-uuid';
        handlerWithAllowlist.storePendingDeletion(uuid, SAMPLE_CONTACT.personId);

        const { interaction, editReply } = makeButtonInteraction(`contact-delete-confirm:${uuid}`);

        await handlerWithAllowlist.handleButton(interaction);

        const callArgs = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const title    = callArgs.embeds[0].toJSON().title;
        expect(title).toContain('Deleted');
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            personId: SAMPLE_CONTACT.personId,
            msg:      'Failed to remove person from allowlist after contact deletion',
        }));
    });

    test('does not crash when personAllowlist is undefined in ContactApprovalHandler', async () => {
        // handler without 2nd arg (personAllowlist undefined)
        const uuid = 'delete-no-allowlist-uuid';
        handler.storePendingDeletion(uuid, SAMPLE_CONTACT.personId);

        const { interaction, editReply } = makeButtonInteraction(`contact-delete-confirm:${uuid}`);

        await handler.handleButton(interaction);

        const callArgs = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const title    = callArgs.embeds[0].toJSON().title;
        expect(title).toContain('Deleted');
    });
});

// ---------------------------------------------------------------------------
// ContactCommandHandler - edit subcommand
// ---------------------------------------------------------------------------

describe('ContactCommandHandler - edit subcommand', () => {
    let backend: ReturnType<typeof createMockBackend>;
    let handler: ContactCommandHandler;

    beforeEach(() => {
        backend = createMockBackend();
        handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
    });

    test('updates notes when provided', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'edit', {
            person: 'alice-wonderland',
            notes:  'Updated notes',
        });

        await handler.handle(asChatInput);

        expect(backend.putContact).toHaveBeenCalledWith(
            expect.objectContaining({ notes: 'Updated notes' }) as unknown
        );
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('updated') as unknown as string })
        );
    });

    test('clears notes when empty string provided', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'edit', {
            person: 'alice-wonderland',
            notes:  '',
        });

        await handler.handle(asChatInput);

        const putArgs = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(putArgs.notes).toBeUndefined();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('updated') as unknown as string })
        );
    });

    test('updates display name and name identifier in identifiers array', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'edit', {
            person: 'alice-wonderland',
            name:   'Alice Smith',
        });

        await handler.handle(asChatInput);

        const putArgs = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(putArgs.displayName).toBe('Alice Smith');
        const nameId = putArgs.identifiers.find(id => id.platform === 'name');
        expect(nameId?.value).toBe('Alice Smith');
        // Other identifiers remain unchanged
        const emailId = putArgs.identifiers.find(id => id.platform === 'email');
        expect(emailId?.value).toBe('alice@example.com');
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Alice Smith') as unknown as string })
        );
    });

    test('updates both name and notes together', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'edit', {
            person: 'alice-wonderland',
            name:   'Alice Smith',
            notes:  'New notes',
        });

        await handler.handle(asChatInput);

        const putArgs = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(putArgs.displayName).toBe('Alice Smith');
        expect(putArgs.notes).toBe('New notes');
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('updated') as unknown as string })
        );
    });

    test('replies "No changes specified." when neither name nor notes provided', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'edit', {
            person: 'alice-wonderland',
        });

        await handler.handle(asChatInput);

        expect(backend.putContact).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: 'No changes specified.' })
        );
    });

    test('replies not found when contact does not exist', async () => {
        backend.getContact.mockImplementation(async () => undefined);
        backend.fuzzyLookup.mockImplementation(async () => []);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'edit', {
            person: 'no-such-person',
            notes:  'Some notes',
        });

        await handler.handle(asChatInput);

        expect(backend.putContact).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('No contact found') as unknown as string })
        );
    });

    test('replies with error on putContact failure', async () => {
        backend.getContact.mockImplementation(async () => SAMPLE_CONTACT);
        backend.putContact.mockImplementation(async () => {
            throw new Error('DynamoDB failure');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'edit', {
            person: 'alice-wonderland',
            notes:  'Something',
        });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Failed to edit contact') as unknown as string })
        );
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            personRaw: 'alice-wonderland',
            msg:       'Failed to edit contact',
        }));
    });

    test('rejects non-admin users', async () => {
        const { asChatInput, reply } = createMockInteraction('non-admin-id', 'edit', {
            person: 'alice-wonderland',
            notes:  'Something',
        });

        await handler.handle(asChatInput);

        expect(reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Only the admin') as unknown as string })
        );
        expect(backend.putContact).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Mutation regression contracts
// ---------------------------------------------------------------------------

describe('Contact command public response contracts', () => {
    test('uses distinct, correctly styled approve and reject buttons', () => {
        const { embed, actionRow } = buildContactApprovalEmbed({ action: 'create', displayName: 'Approval Contract', addIdentifiers: [] }, 'approval-contract');
        const buttons = actionRow.toJSON().components as unknown as { type: number, custom_id: string, label: string, style: number }[];

        expect(embed.toJSON().color).toBe(0xFF_AA_00);
        expect(buttons).toEqual([
            { type: 2, custom_id: 'contact-approve:approval-contract', label: 'Approve', style: 3 },
            { type: 2, custom_id: 'contact-reject:approval-contract', label: 'Reject', style: 4 },
        ]);
    });

    test('preserves name-first identifier order and stores ISO timestamps on add', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'add', {
            name:     'Alice Wonderland',
            discord:  'alice',
            email:    'alice@example.com',
            bsky:     'alice.bsky.social',
            nickname: 'Ali',
        });

        await handler.handle(asChatInput);

        const contact = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(contact.identifiers).toEqual([
            { platform: 'name', value: 'Alice Wonderland' },
            { platform: 'discord', value: 'alice' },
            { platform: 'email', value: 'alice@example.com' },
            { platform: 'bsky', value: 'alice.bsky.social' },
            { platform: 'nickname', value: 'Ali' },
        ]);
        expect(contact.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(contact.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('shows the first fuzzy match, rather than a later candidate', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        const first = {
            ...SAMPLE_CONTACT,
            identifiers: [{ platform: 'email' as const, value: 'alice@example.com' }],
        };
        const second = { ...SAMPLE_CONTACT, personId: createPersonId('alice-second'), displayName: 'Alice Second' };
        backend.fuzzyLookup.mockResolvedValue([first, second]);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', { person: 'Alice' });

        await handler.handle(asChatInput);

        const reply = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        expect(reply.embeds[0].toJSON().title).toBe('Alice Wonderland');
        expect(reply.embeds[0].toJSON().fields).toContainEqual({
            name:   'Identifiers',
            value:  'email: alice@example.com',
            inline: false,
        });
    });

    test('includes an Error message, not Error.toString(), in a failed create response', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        backend.putContact.mockImplementation(async () => {
            throw new Error('storage rejected contact');
        });
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { name: 'Alice' });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({ content: 'Failed to create contact: storage rejected contact' });
    });

    test('does not complete an unauthorized command until Discord accepts the reply', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        const replyGate = controlledPromise<void>();
        const { asChatInput, reply } = createMockInteraction('not-admin', 'list');
        reply.mockImplementation(() => {
            replyGate.start();
            return replyGate.promise;
        });

        let completed = false;
        const completion = handler.handle(asChatInput).finally(() => {
            completed = true;
        });
        try {
            await replyGate.started;
            expect(completed).toBe(false);
            replyGate.resolve();
            await completion;
        } finally {
            replyGate.resolve();
            await completion;
        }
    });

    test('does not dispatch a command until Discord accepts the deferred reply', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        const deferGate = controlledPromise<void>();
        const { asChatInput, deferReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        deferReply.mockImplementation(() => {
            deferGate.start();
            return deferGate.promise;
        });

        const completion = handler.handle(asChatInput);
        try {
            await deferGate.started;
            expect(backend.listContacts).not.toHaveBeenCalled();
            deferGate.resolve();
            await completion;
            expect(backend.listContacts).toHaveBeenCalledTimes(1);
        } finally {
            deferGate.resolve();
            await completion;
        }
    });

    test('does not complete list handling until the public list response is accepted', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        const editGate = controlledPromise<void>();
        backend.listContacts.mockResolvedValue([SAMPLE_CONTACT]);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'list');
        editReply.mockImplementation(() => {
            editGate.start();
            return editGate.promise;
        });

        let completed = false;
        const completion = handler.handle(asChatInput).finally(() => {
            completed = true;
        });
        try {
            await editGate.started;
            expect(completed).toBe(false);
            editGate.resolve();
            await completion;
        } finally {
            editGate.resolve();
            await completion;
        }
    });

    test('does not complete a button cancellation until its acknowledgement and public reply finish', async () => {
        const backend = createMockBackend();
        const handler = new ContactApprovalHandler(backend as unknown as ContactBackend);
        handler.storePendingDeletion('deferred-cancel', SAMPLE_CONTACT.personId);
        const deferGate = controlledPromise<void>();
        const editGate = controlledPromise<void>();
        const { interaction, deferUpdate, editReply } = makeButtonInteraction('contact-delete-cancel:deferred-cancel');
        deferUpdate.mockImplementation(() => {
            deferGate.start();
            return deferGate.promise;
        });
        editReply.mockImplementation(() => {
            editGate.start();
            return editGate.promise;
        });

        let completed = false;
        const completion = handler.handleButton(interaction).finally(() => {
            completed = true;
        });
        try {
            await deferGate.started;
            expect(editReply).not.toHaveBeenCalled();
            deferGate.resolve();
            await editGate.started;
            await Bun.sleep(0);
            expect(completed).toBe(false);
            editGate.resolve();
            await completion;
        } finally {
            deferGate.resolve();
            editGate.resolve();
            await completion;
        }
    });

    test('waits for every command response before reporting the command complete', async () => {
        const cases: {
            name:       string
            subcommand: string
            options?:   Record<string, string | null>
            arrange:    (backend: ReturnType<typeof createMockBackend>) => ContactApprovalHandler | undefined
        }[] = [
            { name: 'add invalid name', subcommand: 'add', options: { name: '!!!' }, arrange: () => undefined },
            { name: 'add success', subcommand: 'add', options: { name: 'Alice' }, arrange: () => undefined },
            { name:       'add failure', subcommand: 'add', options:    { name: 'Alice' }, arrange:    (backend) => {
                backend.putContact.mockRejectedValue(new Error('write failed'));
                return undefined;
            } },
            { name: 'link success', subcommand: 'link', options: { person: 'alice', platform: 'email', id: 'a@example.com' }, arrange: () => undefined },
            { name:       'link failure', subcommand: 'link', options:    { person: 'alice', platform: 'email', id: 'a@example.com' }, arrange:    (backend) => {
                backend.addIdentifier.mockRejectedValue(new Error('link failed'));
                return undefined;
            } },
            { name: 'unlink success', subcommand: 'unlink', options: { person: 'alice', platform: 'email', id: 'a@example.com' }, arrange: () => undefined },
            { name:       'unlink failure', subcommand: 'unlink', options:    { person: 'alice', platform: 'email', id: 'a@example.com' }, arrange:    (backend) => {
                backend.removeIdentifier.mockRejectedValue(new Error('unlink failed'));
                return undefined;
            } },
            { name: 'empty list', subcommand: 'list', arrange: () => undefined },
            { name:       'populated list', subcommand: 'list', arrange:    (backend) => {
                backend.listContacts.mockResolvedValue([SAMPLE_CONTACT]);
                return undefined;
            } },
            { name:       'list failure', subcommand: 'list', arrange:    (backend) => {
                backend.listContacts.mockRejectedValue(new Error('list failed'));
                return undefined;
            } },
            { name: 'show not found', subcommand: 'show', options: { person: 'missing' }, arrange: () => undefined },
            { name:       'show success', subcommand: 'show', options:    { person: 'alice' }, arrange:    (backend) => {
                backend.getContact.mockResolvedValue(SAMPLE_CONTACT);
                return undefined;
            } },
            { name:       'show failure', subcommand: 'show', options:    { person: 'alice' }, arrange:    (backend) => {
                backend.getContact.mockRejectedValue(new Error('show failed'));
                return undefined;
            } },
            { name: 'edit with no changes', subcommand: 'edit', options: { person: 'alice' }, arrange: () => undefined },
            { name:       'edit success', subcommand: 'edit', options:    { person: 'alice', notes: 'updated' }, arrange:    (backend) => {
                backend.getContact.mockResolvedValue(SAMPLE_CONTACT);
                return undefined;
            } },
            { name:       'edit failure', subcommand: 'edit', options:    { person: 'alice', notes: 'updated' }, arrange:    (backend) => {
                backend.getContact.mockRejectedValue(new Error('edit failed'));
                return undefined;
            } },
            { name:       'delete unavailable', subcommand: 'delete', options:    { person: 'alice' }, arrange:    (backend) => {
                backend.getContact.mockResolvedValue(SAMPLE_CONTACT);
                return undefined;
            } },
            { name:       'delete confirmation', subcommand: 'delete', options:    { person: 'alice' }, arrange:    (backend) => {
                backend.getContact.mockResolvedValue(SAMPLE_CONTACT);
                return new ContactApprovalHandler(backend as unknown as ContactBackend);
            } },
            { name:       'delete failure', subcommand: 'delete', options:    { person: 'alice' }, arrange:    (backend) => {
                backend.getContact.mockRejectedValue(new Error('delete failed'));
                return undefined;
            } },
        ];

        await Promise.all(cases.map(async (entry) => {
            const backend = createMockBackend();
            const approvalHandler = entry.arrange(backend);
            const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, approvalHandler);
            const replyGate = controlledPromise<void>();
            const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, entry.subcommand, entry.options);
            editReply.mockImplementation(() => {
                replyGate.start();
                return replyGate.promise;
            });

            let completed = false;
            const completion = handler.handle(asChatInput).finally(() => {
                completed = true;
            });
            try {
                await replyGate.started;
                await Bun.sleep(0);
                expect(completed, entry.name).toBe(false);
                replyGate.resolve();
                await completion;
            } finally {
                replyGate.resolve();
                await completion;
            }
        }));
    });

    test('handles a rejected success response by sending the command failure response', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'add', { name: 'Alice' });
        const rejectedReply = Promise.reject(new Error('Discord rejected success response'));
        void rejectedReply.catch(() => {});
        editReply
            .mockImplementationOnce(() => rejectedReply)
            .mockResolvedValueOnce();

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledTimes(2);
        expect(editReply).toHaveBeenLastCalledWith({ content: 'Failed to create contact: Discord rejected success response' });
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            displayName: 'Alice',
            msg:         'Failed to create contact',
        }));
    });

    test('waits for every approval response before reporting the button complete', async () => {
        const cases: { name: string, customId: string, arrange: (handler: ContactApprovalHandler) => void }[] = [
            { name: 'approve missing request', customId: 'contact-approve:missing', arrange: () => {} },
            { name:     'approve success', customId: 'contact-approve:approve', arrange:  (handler) => {
                handler.storePendingRequest('approve', { action: 'create', displayName: 'Alice', addIdentifiers: [] });
            } },
            { name: 'reject missing request', customId: 'contact-reject:missing', arrange: () => {} },
            { name:     'reject success', customId: 'contact-reject:reject', arrange:  (handler) => {
                handler.storePendingRequest('reject', { action: 'create', displayName: 'Alice', addIdentifiers: [] });
            } },
            { name: 'delete confirm missing request', customId: 'contact-delete-confirm:missing', arrange: () => {} },
            { name:     'delete confirm success', customId: 'contact-delete-confirm:confirm', arrange:  (handler) => {
                handler.storePendingDeletion('confirm', SAMPLE_CONTACT.personId);
            } },
            { name: 'delete cancel missing request', customId: 'contact-delete-cancel:missing', arrange: () => {} },
        ];

        await Promise.all(cases.map(async (entry) => {
            const backend = createMockBackend();
            const handler = new ContactApprovalHandler(backend as unknown as ContactBackend);
            entry.arrange(handler);
            const replyGate = controlledPromise<void>();
            const { interaction, editReply } = makeButtonInteraction(entry.customId);
            editReply.mockImplementation(() => {
                replyGate.start();
                return replyGate.promise;
            });

            let completed = false;
            const completion = handler.handleButton(interaction).finally(() => {
                completed = true;
            });
            try {
                await replyGate.started;
                await Bun.sleep(0);
                expect(completed, entry.name).toBe(false);
                replyGate.resolve();
                await completion;
            } finally {
                replyGate.resolve();
                await completion;
            }
        }));
    });

    test('waits for each approval update write and reports a rejected write through the public error response', async () => {
        const cases: {
            name:      string
            request:   ContactChangeRequest
            operation: 'addIdentifier' | 'removeIdentifier' | 'putContact'
            arrange?:  (backend: ReturnType<typeof createMockBackend>) => void
        }[] = [
            {
                name:      'add identifier',
                operation: 'addIdentifier',
                request:   { action: 'update', personId: createPersonId('alice'), addIdentifiers: [{ platform: 'email', value: 'a@example.com' }] },
            },
            {
                name:      'remove identifier',
                operation: 'removeIdentifier',
                request:   { action: 'update', personId: createPersonId('alice'), removeIdentifiers: [{ platform: 'email', value: 'a@example.com' }] },
            },
            {
                name:      'put updated notes',
                operation: 'putContact',
                request:   { action: 'update', personId: createPersonId('alice'), notes: 'updated' },
                arrange:   backend => backend.getContact.mockResolvedValue(SAMPLE_CONTACT),
            },
        ];

        await Promise.all(cases.map(async (entry) => {
            const backend = createMockBackend();
            entry.arrange?.(backend);
            const operationGate = controlledPromise<void>();
            backend[entry.operation].mockImplementation(() => {
                operationGate.start();
                return operationGate.promise;
            });
            const handler = new ContactApprovalHandler(backend as unknown as ContactBackend);
            handler.storePendingRequest(entry.name, entry.request);
            const { interaction, editReply } = makeButtonInteraction(`contact-approve:${entry.name}`);

            let completed = false;
            const completion = handler.handleButton(interaction).finally(() => {
                completed = true;
            });
            try {
                await operationGate.started;
                await Bun.sleep(0);
                expect(completed, entry.name).toBe(false);
                operationGate.resolve();
                await completion;
                expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) as unknown as unknown[] }));
            } finally {
                operationGate.resolve();
                await completion;
            }

            backend[entry.operation].mockRejectedValue(new Error(`${entry.name} failed`));
            handler.storePendingRequest(`${entry.name}-failure`, entry.request);
            const failed = makeButtonInteraction(`contact-approve:${entry.name}-failure`);
            await handler.handleButton(failed.interaction);
            expect(failed.editReply).toHaveBeenCalledWith(expect.objectContaining({
                content: 'An error occurred processing your request. Please try again.',
            }));
        }));
    });
});

describe('Contact command mutation regression contracts', () => {
    test('renders the contact title, success color, and most recent update timestamp', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        const contact: Contact = {
            ...SAMPLE_CONTACT,
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2025-02-03T04:05:06.000Z',
        };
        backend.getContact.mockResolvedValue(contact);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'show', { person: 'alice-wonderland' });

        await handler.handle(asChatInput);

        const reply = (editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        const embed = reply.embeds[0].toJSON();
        expect(embed.title).toBe('Alice Wonderland');
        expect(embed.color).toBe(0x00_AA_00);
        expect(embed.fields).toContainEqual({ name: 'Updated', value: '2025-02-03T04:05:06.000Z', inline: true });
    });

    test('preserves an absent note and writes an ISO update timestamp while editing', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        backend.getContact.mockResolvedValue({ ...SAMPLE_CONTACT, notes: undefined });
        const { asChatInput } = createMockInteraction(ADMIN_USER_ID, 'edit', { person: 'alice-wonderland', name: 'Alice Smith' });

        await handler.handle(asChatInput);

        const updated = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(updated.notes).toBeUndefined();
        expect(updated.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('uses one generated deletion token consistently in the button and pending request', async () => {
        const backend = createMockBackend();
        const approvals = new ContactApprovalHandler(backend as unknown as ContactBackend);
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, approvals);
        const storePendingDeletion = mock((_uuid: string, _personId: Contact['personId']) => {});
        approvals.storePendingDeletion = storePendingDeletion;
        backend.getContact.mockResolvedValue(SAMPLE_CONTACT);
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'delete', { person: 'alice-wonderland' });

        await handler.handle(asChatInput);

        const uuid = storePendingDeletion.mock.calls[0][0];
        const reply = (editReply.mock.calls[0] as [{ components: ActionRowBuilder<ButtonBuilder>[] }])[0];
        const button = reply.components[0].toJSON().components[0] as unknown as { custom_id: string };
        expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
        expect(button.custom_id).toBe(`contact-delete-confirm:${uuid}`);
        expect(reply.components).toHaveLength(1);
    });

    test('returns the generic deletion failure message for ordinary errors', async () => {
        const backend = createMockBackend();
        const approvals = new ContactApprovalHandler(backend as unknown as ContactBackend);
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, approvals);
        backend.getContact.mockRejectedValue(new Error('storage offline'));
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'delete', { person: 'alice-wonderland' });

        await handler.handle(asChatInput);

        expect(editReply).toHaveBeenCalledWith({ content: 'Failed to delete contact: storage offline' });
    });

    test('refreshes the update timestamp when approval changes stored notes', async () => {
        const backend = createMockBackend();
        const approvals = new ContactApprovalHandler(backend as unknown as ContactBackend);
        backend.getContact.mockResolvedValue(SAMPLE_CONTACT);
        approvals.storePendingRequest('notes-update', { action: 'update', personId: createPersonId('alice-wonderland'), notes: 'Updated notes' });
        const { interaction } = makeButtonInteraction('contact-approve:notes-update');

        await approvals.handleButton(interaction);

        const updated = (backend.putContact.mock.calls[0] as [Contact])[0];
        expect(updated.notes).toBe('Updated notes');
        expect(updated.updatedAt).not.toBe(SAMPLE_CONTACT.updatedAt);
    });
});

describe('Contact command error response contracts', () => {
    test('returns the message from an unlink failure and identifies the missing contact', async () => {
        const backend = createMockBackend();
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID);
        backend.removeIdentifier.mockRejectedValueOnce(new Error('storage offline'));
        const generic = createMockInteraction(ADMIN_USER_ID, 'unlink', { person: 'alice', platform: 'email', id: 'alice@example.com' });

        await handler.handle(generic.asChatInput);

        expect(generic.editReply).toHaveBeenCalledWith({ content: 'Failed to remove identifier: storage offline' });

        backend.removeIdentifier.mockRejectedValueOnce(new ContactNotFoundError('missing-person'));
        const missing = createMockInteraction(ADMIN_USER_ID, 'unlink', { person: 'missing-person', platform: 'email', id: 'alice@example.com' });

        await handler.handle(missing.asChatInput);

        expect(missing.editReply).toHaveBeenCalledWith({ content: 'Contact `missing-person` not found.' });
    });

    test('sends exactly one delete embed and stringifies non-Error failures', async () => {
        const backend = createMockBackend();
        const approvals = new ContactApprovalHandler(backend as unknown as ContactBackend);
        const handler = new ContactCommandHandler(backend as unknown as ContactBackend, ADMIN_USER_ID, approvals);
        backend.getContact.mockResolvedValueOnce(SAMPLE_CONTACT);
        const success = createMockInteraction(ADMIN_USER_ID, 'delete', { person: 'alice-wonderland' });

        await handler.handle(success.asChatInput);

        const successReply = (success.editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }])[0];
        expect(successReply.embeds).toHaveLength(1);

        backend.getContact.mockRejectedValueOnce('storage offline');
        const failure = createMockInteraction(ADMIN_USER_ID, 'delete', { person: 'alice-wonderland' });

        await handler.handle(failure.asChatInput);

        expect(failure.editReply).toHaveBeenCalledWith({ content: 'Failed to delete contact: storage offline' });
    });
});
