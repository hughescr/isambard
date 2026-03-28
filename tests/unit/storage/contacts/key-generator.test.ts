import { describe, expect, test } from 'bun:test';
import { ContactKeyGenerator } from '@/storage/contacts/key-generator';
import type { ContactId } from '@/storage/contacts/types';

const PERSON_ID = 'craig-hughes' as ContactId;

describe.concurrent('ContactKeyGenerator', () => {
    describe('createProfileKeys', () => {
        test('creates correct PK and SK', () => {
            const keys = ContactKeyGenerator.createProfileKeys(PERSON_ID);
            expect(keys).toEqual({
                PK: 'CONTACT#craig-hughes',
                SK: 'PROFILE',
            });
        });

        test('uses personId verbatim in PK', () => {
            const id = 'alice-wonderland' as ContactId;
            const keys = ContactKeyGenerator.createProfileKeys(id);
            expect(keys.PK).toBe('CONTACT#alice-wonderland');
        });

        test('always has SK = PROFILE', () => {
            const keys = ContactKeyGenerator.createProfileKeys(PERSON_ID);
            expect(keys.SK).toBe('PROFILE');
        });
    });

    describe('createLookupKeys', () => {
        test('creates correct PK and SK for email', () => {
            const keys = ContactKeyGenerator.createLookupKeys('email', 'alice@example.com', PERSON_ID);
            expect(keys).toEqual({
                PK: 'CONTACT_LOOKUP#email#alice@example.com',
                SK: 'CONTACT#craig-hughes',
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

    describe('parsePersonIdFromPK', () => {
        test('parses personId from valid PK', () => {
            const personId = ContactKeyGenerator.parsePersonIdFromPK('CONTACT#craig-hughes');
            expect(personId).toBe('craig-hughes' as ContactId);
        });

        test('parses single-word personId', () => {
            const personId = ContactKeyGenerator.parsePersonIdFromPK('CONTACT#alice');
            expect(personId).toBe('alice' as ContactId);
        });

        test('throws on invalid PK format', () => {
            expect(() => ContactKeyGenerator.parsePersonIdFromPK('CONTACT_LOOKUP#email#test'))
                .toThrow('Invalid PK format: expected CONTACT#..., got CONTACT_LOOKUP#email#test');
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
        });

        test('throws when missing platform separator', () => {
            expect(() => ContactKeyGenerator.parseLookupPK('CONTACT_LOOKUP#emailonly'))
                .toThrow('Invalid lookup PK format: missing platform separator');
        });

        test('round-trips with createLookupKeys', () => {
            const keys = ContactKeyGenerator.createLookupKeys('email', 'alice@example.com', PERSON_ID);
            const parsed = ContactKeyGenerator.parseLookupPK(keys.PK);
            expect(parsed).toEqual({ platform: 'email', value: 'alice@example.com' });
        });
    });

    describe('parsePersonIdFromLookupSK', () => {
        test('parses personId from lookup SK', () => {
            const personId = ContactKeyGenerator.parsePersonIdFromLookupSK('CONTACT#craig-hughes');
            expect(personId).toBe('craig-hughes' as ContactId);
        });

        test('throws on invalid SK format', () => {
            expect(() => ContactKeyGenerator.parsePersonIdFromLookupSK('PROFILE'))
                .toThrow('Invalid lookup SK format: expected CONTACT#..., got PROFILE');
        });

        test('round-trips with createLookupKeys SK', () => {
            const keys = ContactKeyGenerator.createLookupKeys('email', 'alice@example.com', PERSON_ID);
            const parsed = ContactKeyGenerator.parsePersonIdFromLookupSK(keys.SK);
            expect(parsed).toBe(PERSON_ID);
        });
    });
});
