import { describe, it, expect } from 'bun:test';
import { ZodError } from 'zod';
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

    describe('createKeys', () => {
        it('encodes a personal scope as CALCAL#{userId}', () => {
            expect(CalendarRegistryKeyGenerator.createKeys({ kind: 'personal', userId: 'u1' })).toEqual({ PK: 'CALCAL#u1', SK: 'CALENDARS' });
        });

        it('encodes the shared scope as the unchanged CALCAL#SHARED key', () => {
            expect(CalendarRegistryKeyGenerator.createKeys({ kind: 'shared' })).toEqual({ PK: 'CALCAL#SHARED', SK: 'CALENDARS' });
        });

        it('rejects a personal user ID that would collide with the shared key', () => {
            const collide = (): void => {
                CalendarRegistryKeyGenerator.createUserKeys('SHARED');
            };
            expect(collide).toThrow('Personal user ID SHARED collides with the shared registry key');
            expect(collide).toThrow(expect.objectContaining({ context: expect.objectContaining({ location: 'CalendarRegistryKeyGenerator.createKeys' }) }));
        });

        it('rejects an empty personal user ID', () => {
            expect(() => CalendarRegistryKeyGenerator.createUserKeys('')).toThrow(ZodError);
        });
    });

    describe('parseScope', () => {
        it('decodes CALCAL#SHARED to the shared scope', () => {
            expect(CalendarRegistryKeyGenerator.parseScope('CALCAL#SHARED')).toEqual({ kind: 'shared' });
        });

        it('decodes CALCAL#u1 to a personal scope', () => {
            expect(CalendarRegistryKeyGenerator.parseScope('CALCAL#u1')).toEqual({ kind: 'personal', userId: 'u1' });
        });

        it('decodes a long user ID correctly', () => {
            const longUserId = 'user-1234567890-abcdef';
            expect(CalendarRegistryKeyGenerator.parseScope(`CALCAL#${longUserId}`)).toEqual({ kind: 'personal', userId: longUserId });
        });

        it('rejects an empty personal identifier', () => {
            expect(() => CalendarRegistryKeyGenerator.parseScope('CALCAL#')).toThrow(ZodError);
        });

        it('should throw error for invalid PK prefix', () => {
            const parseInvalidPrefix = (): void => {
                CalendarRegistryKeyGenerator.parseScope('INVALID#user-123');
            };

            expect(parseInvalidPrefix).toThrow('Invalid PK format: expected CALCAL#..., got INVALID#user-123');
            try {
                parseInvalidPrefix();
            } catch (error) {
                expect(error).toMatchObject({
                    context: { location: 'CalendarRegistryKeyGenerator.parseScope' },
                });
            }
        });

        it('should throw error for missing prefix', () => {
            expect(() => {
                CalendarRegistryKeyGenerator.parseScope('user-123');
            }).toThrow('Invalid PK format: expected CALCAL#..., got user-123');
        });

        it('should throw error for lowercase prefix', () => {
            expect(() => {
                CalendarRegistryKeyGenerator.parseScope('calcal#user-123');
            }).toThrow('Invalid PK format: expected CALCAL#..., got calcal#user-123');
        });

        it('rejects a key whose expected prefix appears only in the value', () => {
            expect(() => CalendarRegistryKeyGenerator.parseScope('OTHER#CALCAL#user-123')).toThrow(
                expect.objectContaining({ context: expect.objectContaining({ location: 'CalendarRegistryKeyGenerator.parseScope' }) })
            );
        });
    });

    describe('scope codec', () => {
        it('round trips distinct personal and shared scopes', () => {
            expect(CalendarRegistryKeyGenerator.parseScope(CalendarRegistryKeyGenerator.createKeys({ kind: 'personal', userId: 'u1' }).PK)).toEqual({ kind: 'personal', userId: 'u1' });
            expect(CalendarRegistryKeyGenerator.parseScope(CalendarRegistryKeyGenerator.createKeys({ kind: 'shared' }).PK)).toEqual({ kind: 'shared' });
        });

        it('round trips a personal user ID containing the key separator', () => {
            expect(CalendarRegistryKeyGenerator.parseScope(CalendarRegistryKeyGenerator.createUserKeys('a#b').PK)).toEqual({ kind: 'personal', userId: 'a#b' });
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
        it('should maintain userId through createUserKeys and parseScope', () => {
            const originalUserId = 'user-abc-123';
            const keys = CalendarRegistryKeyGenerator.createUserKeys(originalUserId);

            expect(CalendarRegistryKeyGenerator.parseScope(keys.PK)).toEqual({ kind: 'personal', userId: originalUserId });
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
