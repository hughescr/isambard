import { describe, test, expect, mock } from 'bun:test';
import { type ContactBackend } from '@/storage/contacts/backend';
import { findOrCreateContact } from '@/storage/contacts/find-or-create';
import { createContactId, type Contact } from '@/storage/contacts/types';

const ALICE: Contact = {
    personId:    createContactId('alice'),
    displayName: 'Alice',
    identifiers: [{ platform: 'email', value: 'alice@example.com' }],
    createdAt:   '2026-01-01T00:00:00.000Z',
    updatedAt:   '2026-01-01T00:00:00.000Z',
};

const BOB: Contact = {
    personId:    createContactId('bob'),
    displayName: 'Bob',
    identifiers: [{ platform: 'email', value: 'bob@example.com' }],
    createdAt:   '2026-01-02T00:00:00.000Z',
    updatedAt:   '2026-01-02T00:00:00.000Z',
};

interface BackendOverrides {
    resolveIdentifier?: () => Promise<Contact[]>
    getContact?:        () => Promise<Contact | undefined>
    putContact?:        () => Promise<void>
}

function makeBackend(overrides?: BackendOverrides): ContactBackend {
    return {
        resolveIdentifier: mock(async () => []),
        getContact:        mock(async () => undefined),
        putContact:        mock(async () => {}),
        ...overrides,
    } as unknown as ContactBackend;
}

describe('findOrCreateContact', () => {
    test('returns existing personId when identifier resolves', async () => {
        const backend = makeBackend({
            resolveIdentifier: mock(async () => [ALICE]),
        });

        const result = await findOrCreateContact(backend, 'email', 'alice@example.com', 'Alice');

        expect(result).toBe(ALICE.personId);
        expect((backend.putContact as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    });

    test('returns first match when multiple contacts resolve', async () => {
        const backend = makeBackend({
            resolveIdentifier: mock(async () => [ALICE, BOB]),
        });

        const result = await findOrCreateContact(backend, 'email', 'shared@example.com', 'Shared');

        expect(result).toBe(ALICE.personId);
        expect((backend.putContact as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    });

    test('creates new contact when no match found', async () => {
        const backend = makeBackend({
            resolveIdentifier: mock(async () => []),
            getContact:        mock(async () => undefined),
        });

        const result = await findOrCreateContact(backend, 'email', 'alice@example.com', 'Alice');

        expect(result).toBe(createContactId('alice'));
        const putCalls = (backend.putContact as ReturnType<typeof mock>).mock.calls;
        expect(putCalls).toHaveLength(1);
        const [contact] = putCalls[0] as [Contact];
        expect(contact.personId).toBe(createContactId('alice'));
        expect(contact.displayName).toBe('Alice');
        expect(contact.identifiers).toEqual([{ platform: 'email', value: 'alice@example.com' }]);
        expect(contact.createdAt).toBeDefined();
        expect(contact.updatedAt).toBeDefined();
    });

    test('passes notes to new contact when provided', async () => {
        const backend = makeBackend();

        await findOrCreateContact(backend, 'bsky', 'alice.bsky.social', 'Alice', { notes: 'Met at conference' });

        const putCalls = (backend.putContact as ReturnType<typeof mock>).mock.calls;
        const [contact] = putCalls[0] as [Contact];
        expect(contact.notes).toBe('Met at conference');
    });

    test('does not include notes when opts is undefined', async () => {
        const backend = makeBackend();

        await findOrCreateContact(backend, 'bsky', 'alice.bsky.social', 'Alice');

        const putCalls = (backend.putContact as ReturnType<typeof mock>).mock.calls;
        const [contact] = putCalls[0] as [Contact];
        expect(contact.notes).toBeUndefined();
    });

    test('handles personId collision by finding available suffix', async () => {
        let getContactCallCount = 0;
        const backend = makeBackend({
            resolveIdentifier: mock(async () => []),
            getContact:        mock(async () => {
                getContactCallCount++;
                // First call: "alice" is taken; second call: "alice-2" is free
                if(getContactCallCount === 1) {
                    return ALICE;
                }
                return undefined;
            }),
        });

        const result = await findOrCreateContact(backend, 'email', 'alice2@example.com', 'Alice');

        expect(result).toBe(createContactId('alice-2'));
        const putCalls = (backend.putContact as ReturnType<typeof mock>).mock.calls;
        const [contact] = putCalls[0] as [Contact];
        expect(contact.personId).toBe(createContactId('alice-2'));
    });
});
