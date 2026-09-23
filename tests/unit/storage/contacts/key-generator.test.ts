import { describe, expect, test } from 'bun:test';
import { ContactKeyGenerator } from '@/storage/contacts/key-generator';
import { contactIdentifierKey, type PersonId } from '@/storage/contacts/types';
import { createPrefixedKey } from '@/storage/utils/key-builder';

const PERSON_ID = 'craig-hughes' as PersonId;

describe.concurrent('ContactKeyGenerator', () => {
    test.each([
        ['profile PK', () => ContactKeyGenerator.parsePersonIdFromPK('OTHER#CONTACT#craig-hughes'), 'ContactKeyGenerator.parsePersonIdFromPK'],
        ['lookup PK', () => ContactKeyGenerator.parseLookupPK('OTHER#CONTACT_LOOKUP#email#alice@example.com'), 'ContactKeyGenerator.parseLookupPK'],
        ['lookup SK', () => ContactKeyGenerator.parsePersonIdFromLookupSK('OTHER#CONTACT#craig-hughes'), 'ContactKeyGenerator.parsePersonIdFromLookupSK'],
    ])('rejects an expected prefix appearing only inside a %s', (_case, parse, location) => {
        expect(parse).toThrow(expect.objectContaining({ context: expect.objectContaining({ location }) }));
    });

    describe('createProfileKeys', () => {
        test('creates correct PK and SK', () => {
            const keys = ContactKeyGenerator.createProfileKeys(PERSON_ID);
            expect(keys).toEqual({
                PK: 'CONTACT#craig-hughes',
                SK: 'PROFILE',
            });
        });

        test('uses personId verbatim in PK', () => {
            const id = 'alice-wonderland' as PersonId;
            const keys = ContactKeyGenerator.createProfileKeys(id);
            expect(keys.PK).toBe('CONTACT#alice-wonderland');
        });

        test('always has SK = PROFILE', () => {
            const keys = ContactKeyGenerator.createProfileKeys(PERSON_ID);
            expect(keys.SK).toBe('PROFILE');
        });
    });

    describe('createLookupKeys', () => {
        test('creates correct PK, SK, GSI2PK, and GSI2SK for email', () => {
            const keys = ContactKeyGenerator.createLookupKeys('email', 'alice@example.com', PERSON_ID);
            expect(keys).toEqual({
                PK:     'CONTACT_LOOKUP#email#alice@example.com',
                SK:     'CONTACT#craig-hughes',
                GSI2PK: 'CONTACT_LOOKUPS',
                GSI2SK: 'CONTACT#craig-hughes#email#alice@example.com',
            });
        });

        test('normalizes value to lowercase', () => {
            const keys = ContactKeyGenerator.createLookupKeys('email', 'Alice@Example.COM', PERSON_ID);
            expect(keys.PK).toBe('CONTACT_LOOKUP#email#alice@example.com');
        });

        test('trims whitespace from value', () => {
            const keys = ContactKeyGenerator.createLookupKeys('name', '  Alice  ', PERSON_ID);
            expect(keys.PK).toBe('CONTACT_LOOKUP#name#alice');
        });

        test('normalizes and trims together', () => {
            const keys = ContactKeyGenerator.createLookupKeys('bsky', '  Alice.bsky.social  ', PERSON_ID);
            expect(keys.PK).toBe('CONTACT_LOOKUP#bsky#alice.bsky.social');
        });

        test('creates correct SK with personId', () => {
            const keys = ContactKeyGenerator.createLookupKeys('discord', 'alice#1234', PERSON_ID);
            expect(keys.SK).toBe('CONTACT#craig-hughes');
        });

        test.each(['name', 'nickname', 'discord', 'email', 'bsky'] as const)(
            'creates lookup for platform %s',
            (platform) => {
                const keys = ContactKeyGenerator.createLookupKeys(platform, 'testvalue', PERSON_ID);
                expect(keys.PK).toMatch(new RegExp(`^CONTACT_LOOKUP#${platform}#`));
            }
        );
    });

    describe('createLookupPK', () => {
        test('builds the normalized CONTACT_LOOKUP partition key', () => {
            expect(ContactKeyGenerator.createLookupPK('email', ' Alice@Example.COM ')).toBe('CONTACT_LOOKUP#email#alice@example.com');
        });

        test('agrees with createLookupKeys and the shared contactIdentifierKey for a padded mixed-case value', () => {
            const expected = 'CONTACT_LOOKUP#bsky#alice.bsky.social';
            expect(ContactKeyGenerator.createLookupKeys('bsky', '  Alice.bsky.social  ', PERSON_ID).PK).toBe(expected);
            expect(ContactKeyGenerator.createLookupPK('bsky', '  Alice.bsky.social  ')).toBe(expected);
            expect(createPrefixedKey('CONTACT_LOOKUP', contactIdentifierKey('bsky', '  Alice.bsky.social  '))).toBe(expected);
        });
    });

    describe('parsePersonIdFromPK', () => {
        test('parses personId from valid PK', () => {
            const personId = ContactKeyGenerator.parsePersonIdFromPK('CONTACT#craig-hughes');
            expect(personId).toBe('craig-hughes' as PersonId);
        });

        test('parses single-word personId', () => {
            const personId = ContactKeyGenerator.parsePersonIdFromPK('CONTACT#alice');
            expect(personId).toBe('alice' as PersonId);
        });

        test('throws on invalid PK format', () => {
            expect(() => ContactKeyGenerator.parsePersonIdFromPK('CONTACT_LOOKUP#email#test'))
                .toThrow('Invalid PK format: expected CONTACT#..., got CONTACT_LOOKUP#email#test');
            expect(() => ContactKeyGenerator.parsePersonIdFromPK('CONTACT_LOOKUP#email#test'))
                .toThrow('Invariant violated in ContactKeyGenerator.parsePersonIdFromPK:');
        });

        test('throws on completely wrong PK', () => {
            expect(() => ContactKeyGenerator.parsePersonIdFromPK('CHANNEL#123'))
                .toThrow('Invalid PK format: expected CONTACT#..., got CHANNEL#123');
        });

        test('round-trips with createProfileKeys', () => {
            const keys = ContactKeyGenerator.createProfileKeys(PERSON_ID);
            const parsed = ContactKeyGenerator.parsePersonIdFromPK(keys.PK);
            expect(parsed).toBe(PERSON_ID);
        });
    });

    describe('parseLookupPK', () => {
        test('parses platform and value from lookup PK', () => {
            const result = ContactKeyGenerator.parseLookupPK('CONTACT_LOOKUP#email#alice@example.com');
            expect(result).toEqual({ platform: 'email', value: 'alice@example.com' });
        });

        test('parses value that contains hash characters', () => {
            const result = ContactKeyGenerator.parseLookupPK('CONTACT_LOOKUP#discord#alice#1234');
            expect(result).toEqual({ platform: 'discord', value: 'alice#1234' });
        });

        test('throws on invalid prefix', () => {
            expect(() => ContactKeyGenerator.parseLookupPK('CONTACT#craig-hughes'))
                .toThrow('Invalid lookup PK format: expected CONTACT_LOOKUP#..., got CONTACT#craig-hughes');
            expect(() => ContactKeyGenerator.parseLookupPK('CONTACT#craig-hughes'))
                .toThrow('Invariant violated in ContactKeyGenerator.parseLookupPK:');
        });

        test('throws when missing platform separator', () => {
            expect(() => ContactKeyGenerator.parseLookupPK('CONTACT_LOOKUP#emailonly'))
                .toThrow('Invalid lookup PK format: missing platform separator');
            expect(() => ContactKeyGenerator.parseLookupPK('CONTACT_LOOKUP#emailonly'))
                .toThrow('Invariant violated in ContactKeyGenerator.parseLookupPK:');
        });

        test('round-trips with createLookupKeys', () => {
            const keys = ContactKeyGenerator.createLookupKeys('email', 'alice@example.com', PERSON_ID);
            const parsed = ContactKeyGenerator.parseLookupPK(keys.PK);
            expect(parsed).toEqual({ platform: 'email', value: 'alice@example.com' });
        });

        test('throws on invalid platform string', () => {
            expect(() => ContactKeyGenerator.parseLookupPK('CONTACT_LOOKUP#invalid#value'))
                .toThrow();
        });
    });

    describe('createCollectionKeys', () => {
        test('creates correct GSI2PK and GSI2SK', () => {
            const keys = ContactKeyGenerator.createCollectionKeys(PERSON_ID);
            expect(keys).toEqual({
                GSI2PK: 'CONTACTS',
                GSI2SK: 'CONTACT#craig-hughes',
            });
        });

        test('always has GSI2PK = CONTACTS', () => {
            const id = 'alice-wonderland' as PersonId;
            const keys = ContactKeyGenerator.createCollectionKeys(id);
            expect(keys.GSI2PK).toBe('CONTACTS');
        });

        test('uses personId in GSI2SK', () => {
            const id = 'bob-smith' as PersonId;
            const keys = ContactKeyGenerator.createCollectionKeys(id);
            expect(keys.GSI2SK).toBe('CONTACT#bob-smith');
        });

        test('round-trips: personId can be parsed from GSI2SK via parsePersonIdFromPK', () => {
            const keys = ContactKeyGenerator.createCollectionKeys(PERSON_ID);
            // GSI2SK has same CONTACT# prefix as PK, so parsePersonIdFromPK can parse it
            const parsed = ContactKeyGenerator.parsePersonIdFromPK(keys.GSI2SK);
            expect(parsed).toBe(PERSON_ID);
        });
    });

    describe('parsePersonIdFromLookupSK', () => {
        test('parses personId from lookup SK', () => {
            const personId = ContactKeyGenerator.parsePersonIdFromLookupSK('CONTACT#craig-hughes');
            expect(personId).toBe('craig-hughes' as PersonId);
        });

        test('throws on invalid SK format', () => {
            expect(() => ContactKeyGenerator.parsePersonIdFromLookupSK('PROFILE'))
                .toThrow('Invalid lookup SK format: expected CONTACT#..., got PROFILE');
            expect(() => ContactKeyGenerator.parsePersonIdFromLookupSK('PROFILE'))
                .toThrow('Invariant violated in ContactKeyGenerator.parsePersonIdFromLookupSK:');
        });

        test('round-trips with createLookupKeys SK', () => {
            const keys = ContactKeyGenerator.createLookupKeys('email', 'alice@example.com', PERSON_ID);
            const parsed = ContactKeyGenerator.parsePersonIdFromLookupSK(keys.SK);
            expect(parsed).toBe(PERSON_ID);
        });
    });
});
