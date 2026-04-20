import { describe, expect, test } from 'bun:test';
import { createPrefixedKey, parsePrefixedKey } from '@/storage/utils/key-builder';

describe.concurrent('createPrefixedKey', () => {
    describe('single-part keys', () => {
        test('creates PREFIX#value key', () => {
            expect(createPrefixedKey('CONTACT', 'craig-hughes')).toBe('CONTACT#craig-hughes');
        });

        test('creates CHANNEL#id key', () => {
            expect(createPrefixedKey('CHANNEL', '123456')).toBe('CHANNEL#123456');
        });

        test('creates GUILD#id key', () => {
            expect(createPrefixedKey('GUILD', '789012')).toBe('GUILD#789012');
        });

        test('creates CALCAL#userId key', () => {
            expect(createPrefixedKey('CALCAL', 'user-123')).toBe('CALCAL#user-123');
        });

        test('creates SAGA#id key', () => {
            expect(createPrefixedKey('SAGA', 'aaaaaaaa-1111-4222-8333-444444444444')).toBe(
                'SAGA#aaaaaaaa-1111-4222-8333-444444444444'
            );
        });

        test('creates REJECTION#uuid key', () => {
            expect(createPrefixedKey('REJECTION', 'aaaaaaaa-1111-4222-8333-444444444444')).toBe(
                'REJECTION#aaaaaaaa-1111-4222-8333-444444444444'
            );
        });

        test('creates WELLKNOWN#type key', () => {
            expect(createPrefixedKey('WELLKNOWN', 'catch-up')).toBe('WELLKNOWN#catch-up');
        });
    });

    describe('multi-part keys', () => {
        test('creates CONTACT_LOOKUP#platform#value key', () => {
            expect(createPrefixedKey('CONTACT_LOOKUP', 'email', 'alice@example.com')).toBe(
                'CONTACT_LOOKUP#email#alice@example.com'
            );
        });

        test('creates three-part key correctly', () => {
            expect(createPrefixedKey('PREFIX', 'a', 'b', 'c')).toBe('PREFIX#a#b#c');
        });

        test('value containing # is preserved verbatim in last part', () => {
            expect(createPrefixedKey('CONTACT_LOOKUP', 'discord', 'alice#1234')).toBe(
                'CONTACT_LOOKUP#discord#alice#1234'
            );
        });
    });

    describe('edge cases', () => {
        test('creates key with empty part', () => {
            expect(createPrefixedKey('CHANNEL', '')).toBe('CHANNEL#');
        });

        test('creates key with zero parts (prefix only with separator)', () => {
            expect(createPrefixedKey('STATIC')).toBe('STATIC');
        });
    });

    describe('key pinning — byte-for-byte identical to existing backends', () => {
        // These tests pin the exact key strings that are stored in DynamoDB production.
        // If any of these fail, a change has broken DynamoDB key compatibility.

        test('CONTACT profile PK matches ContactKeyGenerator', () => {
            expect(createPrefixedKey('CONTACT', 'craig-hughes')).toBe('CONTACT#craig-hughes');
        });

        test('CONTACT_LOOKUP PK matches ContactKeyGenerator', () => {
            expect(createPrefixedKey('CONTACT_LOOKUP', 'email', 'alice@example.com')).toBe(
                'CONTACT_LOOKUP#email#alice@example.com'
            );
        });

        test('CONTACT lookup SK matches ContactKeyGenerator', () => {
            expect(createPrefixedKey('CONTACT', 'alice-smith')).toBe('CONTACT#alice-smith');
        });

        test('CHANNEL PK matches ChannelRegistryKeyGenerator', () => {
            expect(createPrefixedKey('CHANNEL', '1234567890123456789')).toBe('CHANNEL#1234567890123456789');
        });

        test('GUILD GSI1PK matches ChannelRegistryKeyGenerator', () => {
            expect(createPrefixedKey('GUILD', '9876543210987654321')).toBe('GUILD#9876543210987654321');
        });

        test('WELLKNOWN GSI2PK matches ChannelRegistryKeyGenerator', () => {
            expect(createPrefixedKey('WELLKNOWN', 'catch-up')).toBe('WELLKNOWN#catch-up');
        });

        test('CALCAL PK matches CalendarRegistryKeyGenerator', () => {
            expect(createPrefixedKey('CALCAL', 'user-123')).toBe('CALCAL#user-123');
        });

        test('CALCAL SHARED key matches CalendarRegistryKeyGenerator', () => {
            expect(createPrefixedKey('CALCAL', 'SHARED')).toBe('CALCAL#SHARED');
        });

        test('SAGA SK matches AllowlistSagaBackend sagaSK helper', () => {
            expect(createPrefixedKey('SAGA', 'test-id-123')).toBe('SAGA#test-id-123');
        });

        test('SAGA SK matches ApprovalSagaBackend sagaSK helper', () => {
            expect(createPrefixedKey('SAGA', 'approval-id-456')).toBe('SAGA#approval-id-456');
        });

        test('REJECTION SK matches BskyRejectionBackend rejectionSK helper', () => {
            expect(createPrefixedKey('REJECTION', 'bbbbbbbb-2222-4333-8444-555555555555')).toBe(
                'REJECTION#bbbbbbbb-2222-4333-8444-555555555555'
            );
        });
    });
});

describe.concurrent('parsePrefixedKey', () => {
    describe('single-part keys', () => {
        test('parses CONTACT#craig-hughes to craig-hughes', () => {
            expect(parsePrefixedKey('CONTACT', 'CONTACT#craig-hughes')).toBe('craig-hughes');
        });

        test('parses CHANNEL#123456 to 123456', () => {
            expect(parsePrefixedKey('CHANNEL', 'CHANNEL#123456')).toBe('123456');
        });

        test('parses CALCAL#user-123 to user-123', () => {
            expect(parsePrefixedKey('CALCAL', 'CALCAL#user-123')).toBe('user-123');
        });

        test('parses SAGA#test-id to test-id', () => {
            expect(parsePrefixedKey('SAGA', 'SAGA#test-id')).toBe('test-id');
        });

        test('parses empty value', () => {
            expect(parsePrefixedKey('CHANNEL', 'CHANNEL#')).toBe('');
        });
    });

    describe('multi-part keys — returns full remainder including embedded #', () => {
        test('parses CONTACT_LOOKUP#email#alice@example.com remainder', () => {
            expect(parsePrefixedKey('CONTACT_LOOKUP', 'CONTACT_LOOKUP#email#alice@example.com')).toBe(
                'email#alice@example.com'
            );
        });

        test('preserves # in value portion', () => {
            expect(parsePrefixedKey('CONTACT_LOOKUP', 'CONTACT_LOOKUP#discord#alice#1234')).toBe(
                'discord#alice#1234'
            );
        });
    });

    describe('error handling', () => {
        test('throws when key does not start with prefix#', () => {
            expect(() => parsePrefixedKey('CONTACT', 'CHANNEL#123')).toThrow(
                'Invalid key format: expected CONTACT#..., got CHANNEL#123'
            );
        });

        test('throws for wrong prefix', () => {
            expect(() => parsePrefixedKey('CALCAL', 'CHANNEL#user-123')).toThrow(
                'Invalid key format: expected CALCAL#..., got CHANNEL#user-123'
            );
        });

        test('throws for partial prefix match', () => {
            expect(() => parsePrefixedKey('CONTACT', 'CONTACT_LOOKUP#email#val')).toThrow(
                'Invalid key format: expected CONTACT#..., got CONTACT_LOOKUP#email#val'
            );
        });

        test('throws for missing # separator', () => {
            expect(() => parsePrefixedKey('CONTACT', 'CONTACT')).toThrow(
                'Invalid key format: expected CONTACT#..., got CONTACT'
            );
        });

        test('throws for empty key', () => {
            expect(() => parsePrefixedKey('CONTACT', '')).toThrow(
                'Invalid key format: expected CONTACT#..., got '
            );
        });
    });

    describe('round-trip consistency', () => {
        test('round-trips single-part key', () => {
            const key = createPrefixedKey('CONTACT', 'craig-hughes');
            expect(parsePrefixedKey('CONTACT', key)).toBe('craig-hughes');
        });

        test('round-trips CALCAL key', () => {
            const key = createPrefixedKey('CALCAL', 'user-abc-123');
            expect(parsePrefixedKey('CALCAL', key)).toBe('user-abc-123');
        });

        test('round-trips SAGA key', () => {
            const id = 'aaaaaaaa-1111-4222-8333-444444444444';
            const key = createPrefixedKey('SAGA', id);
            expect(parsePrefixedKey('SAGA', key)).toBe(id);
        });
    });
});
