import { describe, expect, test } from 'bun:test';
import { ContactKeyGenerator } from '@/storage/contacts/key-generator';
import {
    personIdSchema,
    contactIdentifierKey,
    contactIdentifierSchema,
    contactSchema,
    createPersonId,
    isPersonId,
    normalizeIdentifierValue,
    platformTypeSchema,
    type Contact,
    type ContactChangeRequest,
    type ContactIdentifierKey,
    type PersonId
} from '@/storage/contacts/types';

describe.concurrent('persisted contact row compatibility', () => {
    // A profile row exactly as DynamoDB held it before the identity key was renamed to PersonId.
    const PRE_EXISTING_PROFILE_ITEM = {
        PK:          'CONTACT#alice-wonderland',
        SK:          'PROFILE',
        GSI2PK:      'CONTACTS',
        GSI2SK:      'CONTACT#alice-wonderland',
        personId:    'alice-wonderland',
        displayName: 'Alice Wonderland',
        identifiers: [{ platform: 'email', value: 'Alice@Example.com' }],
        createdAt:   '2026-01-01T00:00:00.000Z',
        updatedAt:   '2026-01-02T00:00:00.000Z',
    };

    test('parses the stored personId attribute byte-identically with personIdSchema', () => {
        expect(personIdSchema.parse(PRE_EXISTING_PROFILE_ITEM.personId)).toBe('alice-wonderland' as PersonId);
    });

    test('parses the stored profile row with contactSchema keeping the same personId', () => {
        const parsed = contactSchema.parse(PRE_EXISTING_PROFILE_ITEM);
        expect(parsed.personId).toBe(PRE_EXISTING_PROFILE_ITEM.personId as PersonId);
        expect(parsed.identifiers).toEqual([{ platform: 'email', value: 'Alice@Example.com' }]);
    });

    test('rebuilds the stored profile keys from the parsed personId', () => {
        const parsed = contactSchema.parse(PRE_EXISTING_PROFILE_ITEM);
        expect(ContactKeyGenerator.createProfileKeys(parsed.personId)).toEqual({ PK: PRE_EXISTING_PROFILE_ITEM.PK, SK: PRE_EXISTING_PROFILE_ITEM.SK });
        expect(ContactKeyGenerator.createCollectionKeys(parsed.personId)).toEqual({ GSI2PK: PRE_EXISTING_PROFILE_ITEM.GSI2PK, GSI2SK: PRE_EXISTING_PROFILE_ITEM.GSI2SK });
    });
});

describe.concurrent('normalizeIdentifierValue', () => {
    test('lowercases mixed-case input', () => {
        expect(normalizeIdentifierValue('Alice@Example.COM')).toBe('alice@example.com');
    });

    test('trims whitespace from both ends', () => {
        expect(normalizeIdentifierValue('  alice  ')).toBe('alice');
    });

    test('does not apply Unicode compatibility folding', () => {
        // Full-width 'Ａ' (U+FF21) and the 'ﬁ' ligature (U+FB01) both fold under NFKC; the
        // contract keeps them, lowercasing only, so persisted lookup keys stay stable.
        expect(normalizeIdentifierValue('Ａlice ﬁle')).toBe('ａlice ﬁle');
    });
});

describe.concurrent('contactIdentifierKey', () => {
    test('joins the platform and the normalized value with #', () => {
        expect(contactIdentifierKey('email', '  Alice@Example.com ')).toBe('email#alice@example.com' as ContactIdentifierKey);
    });

    test('keys the same value differently on different platforms', () => {
        expect(contactIdentifierKey('name', 'x')).not.toBe(contactIdentifierKey('nickname', 'x'));
    });

    test('is not assignable from a plain string', () => {
        // @ts-expect-error a ContactIdentifierKey can only be derived through contactIdentifierKey()
        const key: ContactIdentifierKey = 'email#alice@example.com';
        expect(key).toBe('email#alice@example.com' as ContactIdentifierKey);
    });
});

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

    test('accepts value at the 1-char minimum', () => {
        const result = contactIdentifierSchema.safeParse({ platform: 'name', value: 'a' });
        expect(result.success).toBe(true);
    });

    test('accepts value at the 500-char maximum', () => {
        const result = contactIdentifierSchema.safeParse({ platform: 'name', value: 'a'.repeat(500) });
        expect(result.success).toBe(true);
    });
});

describe.concurrent('ContactChangeRequest', () => {
    test('requires a personId for update requests', () => {
        const update: ContactChangeRequest = {
            action:   'update',
            personId: createPersonId('alice-smith'),
        };
        expect(update.personId).toBe('alice-smith' as PersonId);

        // @ts-expect-error update requests require a branded personId
        const invalidUpdate: ContactChangeRequest = { action: 'update' };
        expect(invalidUpdate.action).toBe('update');
    });
});

describe.concurrent('personIdSchema', () => {
    test.each([
        'alice',
        'alice-smith',
        'craig-hughes',
        'a',
        'user123',
        'user-123',
        'a1b2c3',
    ])('accepts valid id: %s', (id) => {
        const result = personIdSchema.safeParse(id);
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
        const result = personIdSchema.safeParse(id);
        expect(result.success).toBe(false);
    });

    test('rejects id over 100 chars', () => {
        const result = personIdSchema.safeParse('a'.repeat(101));
        expect(result.success).toBe(false);
    });

    test('accepts id at the 100-char maximum', () => {
        const result = personIdSchema.safeParse('a'.repeat(100));
        expect(result.success).toBe(true);
    });

    test('rejects empty id with a too-small issue for the 1-char minimum', () => {
        const result = personIdSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues.some(issue => issue.code === 'too_small')).toBe(true);
        }
    });

    test('rejects id with uppercase letters', () => {
        const result = personIdSchema.safeParse('Craig-Hughes');
        expect(result.success).toBe(false);
    });

    test('explains the required person id format', () => {
        const result = personIdSchema.safeParse('bad id');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toBe('personId must be lowercase alphanumeric with hyphens (kebab-case)');
        }
    });
});

describe.concurrent('createPersonId', () => {
    test('creates PersonId from valid string', () => {
        const id = createPersonId('alice-smith');
        expect(id).toBe('alice-smith' as PersonId);
    });

    test('throws on invalid id', () => {
        expect(() => createPersonId('Alice Smith')).toThrow();
    });

    test('throws on empty string', () => {
        expect(() => createPersonId('')).toThrow();
    });
});

describe.concurrent('isPersonId', () => {
    test('returns true for valid PersonId', () => {
        expect(isPersonId('alice-smith')).toBe(true);
    });

    test('returns false for invalid PersonId', () => {
        expect(isPersonId('Alice Smith')).toBe(false);
    });

    test('returns false for non-string', () => {
        expect(isPersonId(123)).toBe(false);
    });

    test('returns false for empty string', () => {
        expect(isPersonId('')).toBe(false);
    });
});

describe.concurrent('contactSchema', () => {
    const VALID_CONTACT: Contact = {
        personId:    'alice-smith' as PersonId,
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

    test('accepts contact with displayName at the 1-char minimum', () => {
        const result = contactSchema.safeParse({ ...VALID_CONTACT, displayName: 'a' });
        expect(result.success).toBe(true);
    });

    test('accepts contact with displayName at the 200-char maximum', () => {
        const result = contactSchema.safeParse({ ...VALID_CONTACT, displayName: 'a'.repeat(200) });
        expect(result.success).toBe(true);
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
