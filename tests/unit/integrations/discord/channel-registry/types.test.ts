import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
    channelMetadataSchema,
    channelStorageRecordSchema,
    createChannelMetadata,
    isChannelMetadata,
    WELL_KNOWN_CHANNELS,
    wellKnownChannelSchema,
    type ChannelMetadata,
    type WellKnownChannel
} from '../../../../../src/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId } from '../../../../../src/integrations/discord/types';

describe('channel-registry/types', () => {
    describe('wellKnownChannelSchema', () => {
        it('should accept valid well-known channel types', () => {
            const validChannels: WellKnownChannel[] = ['general', 'catch-up', 'perch-time', 'fallback'];
            for(const channel of validChannels) {
                expect(() => wellKnownChannelSchema.parse(channel)).not.toThrow();
            }
        });

        it('should reject invalid channel types', () => {
            expect(() => wellKnownChannelSchema.parse('invalid')).toThrow(z.ZodError);
            expect(() => wellKnownChannelSchema.parse('')).toThrow(z.ZodError);
            expect(() => wellKnownChannelSchema.parse(null)).toThrow(z.ZodError);
            expect(() => wellKnownChannelSchema.parse(undefined)).toThrow(z.ZodError);
        });

        it('should match WELL_KNOWN_CHANNELS constant', () => {
            expect(WELL_KNOWN_CHANNELS).toEqual(['general', 'catch-up', 'perch-time', 'fallback']);
            // Verify all constants are valid
            for(const channel of WELL_KNOWN_CHANNELS) {
                expect(() => wellKnownChannelSchema.parse(channel)).not.toThrow();
            }
        });
    });

    describe('channelStorageRecordSchema', () => {
        const validRecord = {
            channelId: createChannelId('123456789'),
            guildId:   createGuildId('987654321'),
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        };

        it('should default isMuted to false when not specified', () => {
            const result = channelStorageRecordSchema.parse(validRecord);
            expect(result.isMuted).toBe(false);
        });

        it('should accept explicit isMuted values', () => {
            const mutedRecord = { ...validRecord, isMuted: true };
            const result = channelStorageRecordSchema.parse(mutedRecord);
            expect(result.isMuted).toBe(true);

            const unmutedRecord = { ...validRecord, isMuted: false };
            const result2 = channelStorageRecordSchema.parse(unmutedRecord);
            expect(result2.isMuted).toBe(false);
        });

        it('should accept optional isWellKnown field', () => {
            const withWellKnown = { ...validRecord, isWellKnown: 'general' as const };
            const result = channelStorageRecordSchema.parse(withWellKnown);
            expect(result.isWellKnown).toBe('general');
        });

        it('should reject missing required fields', () => {
            const missing = { ...validRecord };
            delete (missing as Partial<typeof missing>).channelId;
            expect(() => channelStorageRecordSchema.parse(missing)).toThrow(z.ZodError);
        });
    });

    describe('channelMetadataSchema', () => {
        const validMetadata = {
            channelId:    createChannelId('123456789'),
            guildId:      createGuildId('987654321'),
            channelName:  'test-channel',
            discoveredAt: '2024-01-01T00:00:00Z',
            lastSeenAt:   '2024-01-02T00:00:00Z',
            updatedAt:    '2024-01-03T00:00:00Z',
        };

        it('should accept valid channel metadata with guild ID', () => {
            const result = channelMetadataSchema.parse(validMetadata);
            expect(result).toBeDefined();
            expect(result.channelId).toBe(validMetadata.channelId);
            expect(result.guildId).toBe(validMetadata.guildId);
            expect(result.isMuted).toBe(false); // default value
        });

        it('should accept valid channel metadata with DM literal', () => {
            const dmMetadata = {
                ...validMetadata,
                guildId: 'DM' as const,
            };
            const result = channelMetadataSchema.parse(dmMetadata);
            expect(result.guildId).toBe('DM');
        });

        it('should default isMuted to false', () => {
            const result = channelMetadataSchema.parse(validMetadata);
            expect(result.isMuted).toBe(false);
        });

        it('should accept explicit isMuted values', () => {
            const mutedMetadata = { ...validMetadata, isMuted: true };
            const result = channelMetadataSchema.parse(mutedMetadata);
            expect(result.isMuted).toBe(true);

            const unmutedMetadata = { ...validMetadata, isMuted: false };
            const result2 = channelMetadataSchema.parse(unmutedMetadata);
            expect(result2.isMuted).toBe(false);
        });

        it('should accept optional isWellKnown field', () => {
            const withWellKnown = { ...validMetadata, isWellKnown: 'general' as const };
            const result = channelMetadataSchema.parse(withWellKnown);
            expect(result.isWellKnown).toBe('general');

            const withoutWellKnown = validMetadata;
            const result2 = channelMetadataSchema.parse(withoutWellKnown);
            expect(result2.isWellKnown).toBeUndefined();
        });

        it('should reject invalid isWellKnown values', () => {
            const invalid = { ...validMetadata, isWellKnown: 'invalid' };
            expect(() => channelMetadataSchema.parse(invalid)).toThrow(z.ZodError);
        });

        it('should reject empty channelName', () => {
            const invalid = { ...validMetadata, channelName: '' };
            expect(() => channelMetadataSchema.parse(invalid)).toThrow(z.ZodError);
        });

        it('should reject invalid datetime strings', () => {
            const invalidDate = { ...validMetadata, discoveredAt: 'not-a-date' };
            expect(() => channelMetadataSchema.parse(invalidDate)).toThrow(z.ZodError);

            const invalidDate2 = { ...validMetadata, lastSeenAt: '2024-01-01' };
            expect(() => channelMetadataSchema.parse(invalidDate2)).toThrow(z.ZodError);
        });

        it('should reject missing required fields', () => {
            const missing = { ...validMetadata };
            delete (missing as Partial<typeof missing>).channelId;
            expect(() => channelMetadataSchema.parse(missing)).toThrow(z.ZodError);
        });

        it('should reject invalid guildId type (not string or DM)', () => {
            const invalid = { ...validMetadata, guildId: 123 };
            expect(() => channelMetadataSchema.parse(invalid)).toThrow(z.ZodError);

            const invalidEmpty = { ...validMetadata, guildId: '' };
            expect(() => channelMetadataSchema.parse(invalidEmpty)).toThrow(z.ZodError);
        });
    });

    describe('createChannelMetadata', () => {
        const validData = {
            channelId:    createChannelId('123456789'),
            guildId:      createGuildId('987654321'),
            channelName:  'test-channel',
            discoveredAt: '2024-01-01T00:00:00Z',
            lastSeenAt:   '2024-01-02T00:00:00Z',
            updatedAt:    '2024-01-03T00:00:00Z',
        };

        it('should create valid ChannelMetadata from valid data', () => {
            const result = createChannelMetadata(validData);
            expect(result).toBeDefined();
            expect(result.channelId).toBe(validData.channelId);
            expect(result.isMuted).toBe(false);
        });

        it('should throw ZodError for invalid data', () => {
            expect(() => createChannelMetadata({})).toThrow(z.ZodError);
            expect(() => createChannelMetadata(null)).toThrow(z.ZodError);
            expect(() => createChannelMetadata(undefined)).toThrow(z.ZodError);
            expect(() => createChannelMetadata('invalid')).toThrow(z.ZodError);
        });

        it('should throw ZodError for partial data', () => {
            const partial = { ...validData };
            delete (partial as Partial<typeof partial>).channelName;
            expect(() => createChannelMetadata(partial)).toThrow(z.ZodError);
        });
    });

    describe('isChannelMetadata', () => {
        const validData: ChannelMetadata = {
            channelId:    createChannelId('123456789'),
            guildId:      createGuildId('987654321'),
            channelName:  'test-channel',
            isMuted:      false,
            discoveredAt: '2024-01-01T00:00:00Z',
            lastSeenAt:   '2024-01-02T00:00:00Z',
            updatedAt:    '2024-01-03T00:00:00Z',
        };

        it('should return true for valid ChannelMetadata', () => {
            expect(isChannelMetadata(validData)).toBe(true);
        });

        it('should return true for valid ChannelMetadata with optional fields', () => {
            const withOptional = { ...validData, isWellKnown: 'general' as const };
            expect(isChannelMetadata(withOptional)).toBe(true);
        });

        it('should return false for invalid data', () => {
            expect(isChannelMetadata({})).toBe(false);
            expect(isChannelMetadata(null)).toBe(false);
            expect(isChannelMetadata(undefined)).toBe(false);
            expect(isChannelMetadata('invalid')).toBe(false);
            expect(isChannelMetadata(123)).toBe(false);
        });

        it('should return false for partial data', () => {
            const partial = { ...validData };
            delete (partial as Partial<typeof partial>).channelName;
            expect(isChannelMetadata(partial)).toBe(false);
        });

        it('should return false for data with invalid types', () => {
            const invalid = { ...validData, isMuted: 'not-a-boolean' };
            expect(isChannelMetadata(invalid)).toBe(false);
        });
    });
});
