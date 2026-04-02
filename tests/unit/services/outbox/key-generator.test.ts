import { describe, test, expect } from 'bun:test';
import { OutboxKeyGenerator } from '@/services/outbox/key-generator';

const DEDUPE_KEY = 'aaaaaaaa-1111-4222-8333-444444444444';

describe('OutboxKeyGenerator', () => {
    describe('createKeys()', () => {
        test('produces PK with OUTBOX# prefix and service name', () => {
            const keys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'medium',
                dedupeKey: DEDUPE_KEY,
            });
            expect(keys.PK).toBe('OUTBOX#discord');
        });

        test('produces SK with ITEM# prefix, priority sort char, and dedupeKey', () => {
            const keys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'medium',
                dedupeKey: DEDUPE_KEY,
            });
            expect(keys.SK).toBe(`ITEM#1#${DEDUPE_KEY}`);
        });

        test('high priority sorts as 0 (lowest sort value)', () => {
            const keys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'high',
                dedupeKey: DEDUPE_KEY,
            });
            expect(keys.SK).toStartWith('ITEM#0#');
        });

        test('medium priority sorts as 1', () => {
            const keys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'medium',
                dedupeKey: DEDUPE_KEY,
            });
            expect(keys.SK).toStartWith('ITEM#1#');
        });

        test('low priority sorts as 2 (highest sort value)', () => {
            const keys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'low',
                dedupeKey: DEDUPE_KEY,
            });
            expect(keys.SK).toStartWith('ITEM#2#');
        });

        test('high < medium < low in SK lexicographic order', () => {
            const highKeys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'high',
                dedupeKey: DEDUPE_KEY,
            });
            const medKeys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'medium',
                dedupeKey: DEDUPE_KEY,
            });
            const lowKeys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'low',
                dedupeKey: DEDUPE_KEY,
            });
            expect(highKeys.SK < medKeys.SK).toBe(true);
            expect(medKeys.SK < lowKeys.SK).toBe(true);
        });

        test('uses service name in PK for different services', () => {
            const discordKeys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'high',
                dedupeKey: DEDUPE_KEY,
            });
            const emailKeys = OutboxKeyGenerator.createKeys({
                service:   'email',
                priority:  'high',
                dedupeKey: DEDUPE_KEY,
            });
            expect(discordKeys.PK).toBe('OUTBOX#discord');
            expect(emailKeys.PK).toBe('OUTBOX#email');
        });

        test('same dedupeKey produces same SK enabling PutItem deduplication', () => {
            const keys1 = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'medium',
                dedupeKey: 'my-dedupe-key',
            });
            const keys2 = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'medium',
                dedupeKey: 'my-dedupe-key',
            });
            expect(keys1.SK).toBe(keys2.SK);
        });
    });

    describe('parseSK()', () => {
        test('parses a valid high-priority SK back to components', () => {
            const sk = `ITEM#0#${DEDUPE_KEY}`;
            const result = OutboxKeyGenerator.parseSK(sk);
            expect(result).toEqual({
                priority:  'high',
                dedupeKey: DEDUPE_KEY,
            });
        });

        test('parses a valid medium-priority SK back to components', () => {
            const sk = `ITEM#1#${DEDUPE_KEY}`;
            const result = OutboxKeyGenerator.parseSK(sk);
            expect(result).toEqual({
                priority:  'medium',
                dedupeKey: DEDUPE_KEY,
            });
        });

        test('parses a valid low-priority SK back to components', () => {
            const sk = `ITEM#2#${DEDUPE_KEY}`;
            const result = OutboxKeyGenerator.parseSK(sk);
            expect(result).toEqual({
                priority:  'low',
                dedupeKey: DEDUPE_KEY,
            });
        });

        test('round-trips through createKeys and parseSK', () => {
            const original = {
                service:   'discord',
                priority:  'low' as const,
                dedupeKey: DEDUPE_KEY,
            };
            const keys  = OutboxKeyGenerator.createKeys(original);
            const parsed = OutboxKeyGenerator.parseSK(keys.SK);
            expect(parsed).toEqual({
                priority:  'low',
                dedupeKey: DEDUPE_KEY,
            });
        });

        test('returns undefined when SK does not start with ITEM#', () => {
            expect(OutboxKeyGenerator.parseSK('OUTBOX#discord')).toBeUndefined();
        });

        test('returns undefined for non-ITEM# prefix SK that would parse validly if prefix guard were skipped', () => {
            // XXXXX0#uuid does not start with ITEM# but sk.slice(5) produces "0#<id>"
            // which would parse as a valid result. This test ensures the prefix guard is required.
            expect(OutboxKeyGenerator.parseSK(
                `XXXXX0#${DEDUPE_KEY}`
            )).toBeUndefined();
        });

        test('returns undefined when SK has no hash after prefix', () => {
            expect(OutboxKeyGenerator.parseSK('ITEM#0')).toBeUndefined();
        });

        test('returns undefined when priority char is not 0, 1, or 2', () => {
            expect(OutboxKeyGenerator.parseSK(`ITEM#9#${DEDUPE_KEY}`)).toBeUndefined();
        });

        test('returns undefined for completely empty string', () => {
            expect(OutboxKeyGenerator.parseSK('')).toBeUndefined();
        });
    });

    describe('createServicePK()', () => {
        test('returns OUTBOX# prefixed service name', () => {
            expect(OutboxKeyGenerator.createServicePK('discord')).toBe('OUTBOX#discord');
        });

        test('returns OUTBOX# prefixed for other service names', () => {
            expect(OutboxKeyGenerator.createServicePK('email')).toBe('OUTBOX#email');
        });

        test('matches PK produced by createKeys for same service', () => {
            const servicePK = OutboxKeyGenerator.createServicePK('discord');
            const keys = OutboxKeyGenerator.createKeys({
                service:   'discord',
                priority:  'high',
                dedupeKey: DEDUPE_KEY,
            });
            expect(servicePK).toBe(keys.PK);
        });
    });
});
