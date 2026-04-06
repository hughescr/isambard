import { describe, test, expect, mock, type Mock } from 'bun:test';
import { createContactId } from '../../../../src/storage/contacts/types';
import { generatePersonId, findAvailablePersonId } from '../../../../src/storage/contacts/utils';
import type { Contact, ContactBackend } from '@/storage';

// ---------------------------------------------------------------------------
// Mock factory
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
// findAvailablePersonId tests
// ---------------------------------------------------------------------------

describe('findAvailablePersonId()', () => {
    test('returns baseId as ContactId when no collision exists', async () => {
        const backend = createMockBackend() as unknown as ContactBackend;
        const result  = await findAvailablePersonId(backend, 'alice-wonderland');
        expect(result).toBe(createContactId('alice-wonderland'));
    });

    test('appends -2 when the baseId already exists', async () => {
        const backend = createMockBackend() as unknown as ContactBackend;
        // First call (baseId) collides, second call (baseId-2) does not
        backend.getContact = mock(async (id: unknown): Promise<Contact | undefined> => {
            return id === 'alice-wonderland' ? SAMPLE_CONTACT : undefined;
        });
        const result = await findAvailablePersonId(backend, 'alice-wonderland');
        expect(result).toBe(createContactId('alice-wonderland-2'));
    });

    test('appends -3 when both baseId and baseId-2 exist', async () => {
        const backend = createMockBackend() as unknown as ContactBackend;
        backend.getContact = mock(async (id: unknown): Promise<Contact | undefined> => {
            return id === 'alice-wonderland' || id === 'alice-wonderland-2' ? SAMPLE_CONTACT : undefined;
        });
        const result = await findAvailablePersonId(backend, 'alice-wonderland');
        expect(result).toBe(createContactId('alice-wonderland-3'));
    });

    test('continues incrementing suffix until a free slot is found', async () => {
        const backend  = createMockBackend() as unknown as ContactBackend;
        const occupied = new Set(['bob', 'bob-2', 'bob-3', 'bob-4']);
        backend.getContact = mock(async (id: unknown): Promise<Contact | undefined> => {
            return occupied.has(id as string) ? SAMPLE_CONTACT : undefined;
        });
        const result = await findAvailablePersonId(backend, 'bob');
        expect(result).toBe(createContactId('bob-5'));
    });
});
