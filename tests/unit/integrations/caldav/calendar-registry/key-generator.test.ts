import { describe, it, expect } from 'bun:test';
import { CalendarRegistryKeyGenerator } from '@/integrations/caldav/calendar-registry/key-generator';

describe('CalendarRegistryKeyGenerator', () => {
    describe('createUserKeys', () => {
        it('should create correct PK/SK for a basic userId', () => {
            const keys = CalendarRegistryKeyGenerator.createUserKeys('user-123');

            expect(keys).toEqual({
                PK: 'CALCAL#user-123',
                SK: 'CALENDARS',
            });
        });

        it('should handle long user IDs', () => {
            const longUserId = 'user-1234567890-abcdef-ghijkl-mnopqr';
            const keys = CalendarRegistryKeyGenerator.createUserKeys(longUserId);

            expect(keys.PK).toBe(`CALCAL#${longUserId}`);
            expect(keys.SK).toBe('CALENDARS');
        });

        it('should handle user IDs with special characters', () => {
            const keys = CalendarRegistryKeyGenerator.createUserKeys('user@example.com');

            expect(keys.PK).toBe('CALCAL#user@example.com');
            expect(keys.SK).toBe('CALENDARS');
        });
    });

    describe('createSharedKeys', () => {
        it('should create correct PK/SK for shared record', () => {
            const keys = CalendarRegistryKeyGenerator.createSharedKeys();

            expect(keys).toEqual({
                PK: 'CALCAL#SHARED',
                SK: 'CALENDARS',
            });
        });

        it('should always return the same keys', () => {
            const keys1 = CalendarRegistryKeyGenerator.createSharedKeys();
            const keys2 = CalendarRegistryKeyGenerator.createSharedKeys();

            expect(keys1).toEqual(keys2);
        });
    });

    describe('parseUserId', () => {
        it('should parse valid PK correctly', () => {
            const userId = CalendarRegistryKeyGenerator.parseUserId('CALCAL#user-123');

            expect(userId).toBe('user-123');
        });

        it('should parse long user ID correctly', () => {
            const longUserId = 'user-1234567890-abcdef';
            const userId = CalendarRegistryKeyGenerator.parseUserId(`CALCAL#${longUserId}`);

            expect(userId).toBe(longUserId);
        });

        it('should handle empty userId portion', () => {
            const userId = CalendarRegistryKeyGenerator.parseUserId('CALCAL#');

            expect(userId).toBe('');
        });

        it('should throw error for invalid PK prefix', () => {
            expect(() => {
                CalendarRegistryKeyGenerator.parseUserId('INVALID#user-123');
            }).toThrow('Invalid PK format: expected CALCAL#..., got INVALID#user-123');
        });

        it('should throw error for missing prefix', () => {
            expect(() => {
                CalendarRegistryKeyGenerator.parseUserId('user-123');
            }).toThrow('Invalid PK format: expected CALCAL#..., got user-123');
        });

        it('should throw error for lowercase prefix', () => {
            expect(() => {
                CalendarRegistryKeyGenerator.parseUserId('calcal#user-123');
            }).toThrow('Invalid PK format: expected CALCAL#..., got calcal#user-123');
        });
    });

    describe('isSharedKey', () => {
        it('should return true for CALCAL#SHARED', () => {
            expect(CalendarRegistryKeyGenerator.isSharedKey('CALCAL#SHARED')).toBe(true);
        });

        it('should return false for user keys', () => {
            expect(CalendarRegistryKeyGenerator.isSharedKey('CALCAL#user-123')).toBe(false);
        });

        it('should return false for lowercase shared', () => {
            expect(CalendarRegistryKeyGenerator.isSharedKey('CALCAL#shared')).toBe(false);
        });

        it('should return false for partial match', () => {
            expect(CalendarRegistryKeyGenerator.isSharedKey('CALCAL#SHARED_EXTRA')).toBe(false);
        });
    });

    describe('round-trip consistency', () => {
        it('should maintain userId through createUserKeys and parseUserId', () => {
            const originalUserId = 'user-abc-123';
            const keys = CalendarRegistryKeyGenerator.createUserKeys(originalUserId);
            const parsedUserId = CalendarRegistryKeyGenerator.parseUserId(keys.PK);

            expect(parsedUserId).toBe(originalUserId);
        });

        it('should identify shared keys created by createSharedKeys', () => {
            const keys = CalendarRegistryKeyGenerator.createSharedKeys();

            expect(CalendarRegistryKeyGenerator.isSharedKey(keys.PK)).toBe(true);
        });

        it('should not identify user keys as shared', () => {
            const keys = CalendarRegistryKeyGenerator.createUserKeys('user-123');

            expect(CalendarRegistryKeyGenerator.isSharedKey(keys.PK)).toBe(false);
        });
    });
});
