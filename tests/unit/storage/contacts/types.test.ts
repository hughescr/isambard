import { describe, expect, test } from 'bun:test';
import {
    contactIdSchema,
    contactIdentifierSchema,
    contactSchema,
    createContactId,
    isContactId,
    platformTypeSchema,
    type Contact,
    type ContactId
} from '@/storage/contacts/types';

describe.concurrent('platformTypeSchema', () => {
    test.each(['name', 'nickname', 'discord', 'email', 'bsky'])('accepts %s', (platform) => {
        const result = platformTypeSchema.safeParse(platform);
        expect(result.success).toBe(true);
    });

    test('rejects unknown platform', () => {
        const result = platformTypeSchema.safeParse('twitter');
        expect(result.success).toBe(false);
    });

    test('rejects empty string', () => {
        const result = platformTypeSchema.safeParse('');
        expect(result.success).toBe(false);
    });
});

describe.concurrent('contactIdentifierSchema', () => {
    test('accepts valid identifier', () => {
        const result = contactIdentifierSchema.safeParse({ platform: 'email', value: 'alice@example.com' });
        expect(result.success).toBe(true);
    });

    test('rejects empty value', () => {
        const result = contactIdentifierSchema.safeParse({ platform: 'email', value: '' });
        expect(result.success).toBe(false);
    });

    test('rejects invalid platform', () => {
        const result = contactIdentifierSchema.safeParse({ platform: 'twitter', value: 'alice' });
        expect(result.success).toBe(false);
    });

    test('rejects value over 500 chars', () => {
        const result = contactIdentifierSchema.safeParse({ platform: 'name', value: 'a'.repeat(501) });
        expect(result.success).toBe(false);
    });
});

describe.concurrent('contactIdSchema', () => {
    test.each([
        'alice',
        'alice-smith',
        'craig-hughes',
        'a',
        'user123',
        'user-123',
        'a1b2c3',
    ])('accepts valid id: %s', (id) => {
        const result = contactIdSchema.safeParse(id);
        expect(result.success).toBe(true);
    });

    test.each([
        '',
        'Alice',
        'ALICE',
        'alice smith',
        '-alice',
        'alice-',
        'alice--smith',
        'alice_smith',
        'Alice-Smith',
    ])('rejects invalid id: %s', (id: string) => {
        const result = contactIdSchema.safeParse(id);
        expect(result.success).toBe(false);
    });

    test('rejects id over 100 chars', () => {
        const result = contactIdSchema.safeParse('a'.repeat(101));
        expect(result.success).toBe(false);
    });

    test('rejects id with uppercase letters', () => {
        const result = contactIdSchema.safeParse('Craig-Hughes');
        expect(result.success).toBe(false);
    });
});

describe.concurrent('createContactId', () => {
    test('creates ContactId from valid string', () => {
        const id = createContactId('alice-smith');
        expect(id).toBe('alice-smith' as ContactId);
    });

    test('throws on invalid id', () => {
        expect(() => createContactId('Alice Smith')).toThrow();
    });

    test('throws on empty string', () => {
        expect(() => createContactId('')).toThrow();
    });
});

describe.concurrent('isContactId', () => {
    test('returns true for valid ContactId', () => {
        expect(isContactId('alice-smith')).toBe(true);
    });

    test('returns false for invalid ContactId', () => {
        expect(isContactId('Alice Smith')).toBe(false);
    });

    test('returns false for non-string', () => {
        expect(isContactId(123)).toBe(false);
    });

    test('returns false for empty string', () => {
        expect(isContactId('')).toBe(false);
    });
});

describe.concurrent('contactSchema', () => {
    const VALID_CONTACT: Contact = {
        personId:    'alice-smith' as ContactId,
        displayName: 'Alice Smith',
        identifiers: [{ platform: 'email', value: 'alice@example.com' }],
        createdAt:   '2026-01-01T00:00:00.000Z',
        updatedAt:   '2026-01-01T00:00:00.000Z',
    };

    test('accepts valid contact with required fields', () => {
        const result = contactSchema.safeParse(VALID_CONTACT);
        expect(result.success).toBe(true);
    });

    test('accepts contact with optional notes', () => {
        const result = contactSchema.safeParse({ ...VALID_CONTACT, notes: 'Met at conf' });
        expect(result.success).toBe(true);
    });

    test('accepts contact with _internal field', () => {
        const result = contactSchema.safeParse({
            ...VALID_CONTACT,
            _internal: { discordUserId: '123456', bskyDid: 'did:plc:abc' },
        });
        expect(result.success).toBe(true);
    });

    test('accepts contact with partial _internal field', () => {
        const result = contactSchema.safeParse({
            ...VALID_CONTACT,
            _internal: { discordUserId: '123456' },
        });
        expect(result.success).toBe(true);
    });

    test('accepts contact without _internal field', () => {
        const result = contactSchema.safeParse(VALID_CONTACT);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data._internal).toBeUndefined();
        }
    });

    test('rejects contact with empty displayName', () => {
        const result = contactSchema.safeParse({ ...VALID_CONTACT, displayName: '' });
        expect(result.success).toBe(false);
    });

    test('rejects contact with displayName over 200 chars', () => {
        const result = contactSchema.safeParse({ ...VALID_CONTACT, displayName: 'a'.repeat(201) });
        expect(result.success).toBe(false);
    });

    test('rejects contact with empty identifiers array', () => {
        const result = contactSchema.safeParse({ ...VALID_CONTACT, identifiers: [] });
        expect(result.success).toBe(false);
    });

    test('accepts contact with multiple identifiers', () => {
        const result = contactSchema.safeParse({
            ...VALID_CONTACT,
            identifiers: [
                { platform: 'email', value: 'alice@example.com' },
                { platform: 'discord', value: 'alice#1234' },
                { platform: 'bsky', value: 'alice.bsky.social' },
            ],
        });
        expect(result.success).toBe(true);
    });

    test('rejects contact with invalid personId', () => {
        const result = contactSchema.safeParse({ ...VALID_CONTACT, personId: 'Alice Smith' });
        expect(result.success).toBe(false);
    });

    test('rejects contact with invalid ISO datetime', () => {
        const result = contactSchema.safeParse({ ...VALID_CONTACT, createdAt: 'not-a-date' });
        expect(result.success).toBe(false);
    });
});
